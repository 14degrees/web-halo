//! Halo Web's match escrow: players' SOL for wagered matches.
//!
//! Each player has a vault, a program account holding their SOL as a free
//! balance (theirs to withdraw) and a locked balance (staked in a match).
//! The game's settlement authority can only move locked SOL, and only by a
//! match's rules: a match pays out exactly the stakes it locked, less a fee
//! no higher than the configured rate. A player joins matches through a
//! session key their wallet approved with a spending limit, so play needs no
//! wallet prompt; and if a match is never settled, every player in it can
//! reclaim their stake after the reclaim delay without us.
//!
//! See services/escrow/README.md and the design document it links.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("3dPU7bDe3Bqfzx7z2g4hVr9cNQGeZqR1oHCkti5uD3bJ");

/// The fee's hard cap, in basis points: 10%.
pub const MAXIMUM_FEE_BPS: u16 = 1_000;
/// Players in one match.
pub const MAXIMUM_PLAYERS: usize = 8;
/// A session lasts at most a day.
pub const MAXIMUM_SESSION_SECONDS: i64 = 24 * 60 * 60;
/// A review hold on a wallet's withdrawals lasts at most 72 hours.
pub const MAXIMUM_HOLD_SECONDS: i64 = 72 * 60 * 60;
/// The reclaim delay is at most a week (and at least an hour).
pub const MAXIMUM_RECLAIM_DELAY: i64 = 7 * 24 * 60 * 60;
pub const MINIMUM_RECLAIM_DELAY: i64 = 60 * 60;

#[program]
pub mod halo_escrow {
    use super::*;

    /// Sets up the program once: who settles matches, who operates it, where
    /// fees go, and its limits.
    pub fn initialize(ctx: Context<Initialize>, settings: Settings) -> Result<()> {
        settings.check()?;
        let config = &mut ctx.accounts.config;
        config.operator = ctx.accounts.operator.key();
        config.apply(&settings);
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// The operator changes the settings, within their hard caps.
    pub fn update_config(ctx: Context<OperateConfig>, settings: Settings) -> Result<()> {
        settings.check()?;
        ctx.accounts.config.apply(&settings);
        Ok(())
    }

    /// The operator stops (or restarts) new matches and joins. Withdrawals
    /// and reclaims are never paused.
    pub fn set_paused(ctx: Context<OperateConfig>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// The operator holds one wallet's withdrawals for review, for at most
    /// 72 hours; the hold lifts by itself.
    pub fn hold_withdrawals(ctx: Context<HoldWithdrawals>, until: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(until <= now + MAXIMUM_HOLD_SECONDS, EscrowError::HoldTooLong);
        ctx.accounts.vault.hold_until = until;
        Ok(())
    }

    /// A player opens their vault.
    pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// The player moves SOL from their wallet into their vault.
    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        require!(lamports > 0, EscrowError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            lamports,
        )?;
        let vault = &mut ctx.accounts.vault;
        vault.free = vault.free.checked_add(lamports).ok_or(EscrowError::Overflow)?;
        Ok(())
    }

    /// The player moves free SOL back to their wallet. Locked SOL stays
    /// until its match ends.
    pub fn withdraw(ctx: Context<Withdraw>, lamports: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.vault;
        require!(lamports > 0, EscrowError::ZeroAmount);
        require!(now >= vault.hold_until, EscrowError::WithdrawalsHeld);
        require!(lamports <= vault.free, EscrowError::InsufficientFree);
        vault.free -= lamports;
        move_lamports(&vault.to_account_info(), &ctx.accounts.owner.to_account_info(), lamports)?;
        Ok(())
    }

    /// The player approves a session key: it may join matches, staking at
    /// most `limit` lamports in all, until `expiry`.
    pub fn open_session(ctx: Context<OwnVault>, session_key: Pubkey, limit: u64, expiry: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(expiry > now && expiry <= now + MAXIMUM_SESSION_SECONDS, EscrowError::BadSessionExpiry);
        let vault = &mut ctx.accounts.vault;
        vault.session_key = session_key;
        vault.session_limit = limit;
        vault.session_spent = 0;
        vault.session_expiry = expiry;
        Ok(())
    }

    /// The player ends their session at once.
    pub fn close_session(ctx: Context<OwnVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.session_key = Pubkey::default();
        vault.session_limit = 0;
        vault.session_expiry = 0;
        Ok(())
    }

    /// The settlement authority opens a match with its stake.
    pub fn create_match(ctx: Context<CreateMatch>, match_id: [u8; 16], stake: u64, capacity: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, EscrowError::Paused);
        require!(stake > 0 && stake <= config.maximum_stake, EscrowError::BadStake);
        require!(capacity >= 2 && capacity as usize <= MAXIMUM_PLAYERS, EscrowError::BadCapacity);
        let game = &mut ctx.accounts.game;
        game.match_id = match_id;
        game.stake = stake;
        game.capacity = capacity;
        game.state = MatchState::Open;
        game.created_at = Clock::get()?.unix_timestamp;
        game.reclaim_delay = config.reclaim_delay;
        game.bump = ctx.bumps.game;
        Ok(())
    }

    /// A player joins a match: their session key and the settlement
    /// authority both sign. The stake moves from free to locked.
    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(!ctx.accounts.config.paused, EscrowError::Paused);
        let game = &mut ctx.accounts.game;
        let vault = &mut ctx.accounts.vault;
        require!(game.state == MatchState::Open, EscrowError::MatchNotOpen);
        require!((game.players.len() as u8) < game.capacity, EscrowError::MatchFull);
        require!(!game.players.contains(&vault.owner), EscrowError::AlreadyJoined);
        require!(
            vault.session_key == ctx.accounts.session_key.key() && vault.session_key != Pubkey::default(),
            EscrowError::BadSession
        );
        require!(now < vault.session_expiry, EscrowError::SessionExpired);
        let spent = vault.session_spent.checked_add(game.stake).ok_or(EscrowError::Overflow)?;
        require!(spent <= vault.session_limit, EscrowError::SessionLimit);
        require!(game.stake <= vault.free, EscrowError::InsufficientFree);
        vault.session_spent = spent;
        vault.free -= game.stake;
        vault.locked = vault.locked.checked_add(game.stake).ok_or(EscrowError::Overflow)?;
        game.players.push(vault.owner);
        Ok(())
    }

    /// The settlement authority pays a match out by its result. The remaining
    /// accounts are the players' vaults, in the order they joined, then the
    /// fee vault. `payouts` are what each player receives; what is left of the
    /// pot is the fee.
    pub fn settle<'info>(
        ctx: Context<'info, Settle<'info>>,
        payouts: Vec<u64>,
        result_hash: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let game = &mut ctx.accounts.game;
        require!(game.state == MatchState::Open, EscrowError::MatchNotOpen);
        require!(game.reclaimed == 0, EscrowError::StakesReclaimed);
        let players = game.players.len();
        require!(players >= 1 && payouts.len() == players, EscrowError::BadPayouts);
        require!(ctx.remaining_accounts.len() == players + 1, EscrowError::BadAccounts);
        let pot = game.stake.checked_mul(players as u64).ok_or(EscrowError::Overflow)?;
        let paid = payouts.iter().try_fold(0u64, |sum, payout| sum.checked_add(*payout)).ok_or(EscrowError::Overflow)?;
        require!(paid <= pot, EscrowError::BadPayouts);
        let fee = pot - paid;
        // at most the configured rate of the pot (rounded down)
        let fee_cap = (pot as u128 * config.fee_bps as u128 / 10_000) as u64;
        require!(fee <= fee_cap, EscrowError::FeeTooHigh);
        let fee_vault = &ctx.remaining_accounts[players];
        require_keys_eq!(fee_vault.key(), config.fee_vault, EscrowError::BadAccounts);

        for (index, owner) in game.players.clone().iter().enumerate() {
            let account = &ctx.remaining_accounts[index];
            let mut vault: Account<'info, Vault> = Account::try_from(account)?;
            require_keys_eq!(vault.owner, *owner, EscrowError::BadAccounts);
            require!(vault.locked >= game.stake, EscrowError::Overflow);
            vault.locked -= game.stake;
            vault.free = vault.free.checked_add(payouts[index]).ok_or(EscrowError::Overflow)?;
            vault.exit(&crate::ID)?;
        }
        // lamports: each vault gives up its stake and receives its payout;
        // the fee vault receives the rest. The total is unchanged.
        for (index, payout) in payouts.iter().enumerate() {
            let account = &ctx.remaining_accounts[index];
            let stake = game.stake;
            let balance = account.lamports();
            let after = balance
                .checked_sub(stake)
                .and_then(|value| value.checked_add(*payout))
                .ok_or(EscrowError::Overflow)?;
            **account.try_borrow_mut_lamports()? = after;
        }
        if fee > 0 {
            let balance = fee_vault.lamports();
            **fee_vault.try_borrow_mut_lamports()? = balance.checked_add(fee).ok_or(EscrowError::Overflow)?;
        }
        game.state = MatchState::Settled;
        game.result_hash = result_hash;
        Ok(())
    }

    /// The settlement authority calls a match off: every stake goes back.
    pub fn void_match<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.state == MatchState::Open, EscrowError::MatchNotOpen);
        require!(ctx.remaining_accounts.len() == game.players.len(), EscrowError::BadAccounts);
        for (index, owner) in game.players.clone().iter().enumerate() {
            if game.reclaimed & (1 << index) != 0 {
                continue;
            }
            let mut vault: Account<'info, Vault> = Account::try_from(&ctx.remaining_accounts[index])?;
            require_keys_eq!(vault.owner, *owner, EscrowError::BadAccounts);
            vault.locked -= game.stake;
            vault.free = vault.free.checked_add(game.stake).ok_or(EscrowError::Overflow)?;
            vault.exit(&crate::ID)?;
        }
        game.state = MatchState::Void;
        Ok(())
    }

    /// The settlement authority closes an ended match and gets its rent back.
    pub fn close_match(ctx: Context<CloseMatch>) -> Result<()> {
        require!(ctx.accounts.game.state != MatchState::Open, EscrowError::MatchNotOpen);
        Ok(())
    }

    /// A player takes their stake back from a match nobody settled within
    /// the reclaim delay, without us.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let game = &mut ctx.accounts.game;
        let vault = &mut ctx.accounts.vault;
        require!(game.state == MatchState::Open, EscrowError::MatchNotOpen);
        require!(now >= game.created_at + game.reclaim_delay, EscrowError::TooEarlyToReclaim);
        let index = game.players.iter().position(|owner| *owner == vault.owner).ok_or(EscrowError::NotInMatch)?;
        require!(game.reclaimed & (1 << index) == 0, EscrowError::StakesReclaimed);
        game.reclaimed |= 1 << index;
        vault.locked -= game.stake;
        vault.free = vault.free.checked_add(game.stake).ok_or(EscrowError::Overflow)?;
        if game.reclaimed.count_ones() as usize == game.players.len() {
            game.state = MatchState::Void;
        }
        Ok(())
    }
}

/// Moves lamports out of a program-owned account (a vault) to any account.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> Result<()> {
    let rent_floor = Rent::get()?.minimum_balance(from.data_len());
    let remaining = from.lamports().checked_sub(lamports).ok_or(EscrowError::Overflow)?;
    require!(remaining >= rent_floor, EscrowError::Overflow);
    **from.try_borrow_mut_lamports()? = remaining;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(lamports).ok_or(EscrowError::Overflow)?;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Settings {
    pub authority: Pubkey,
    pub fee_vault: Pubkey,
    pub fee_bps: u16,
    pub maximum_stake: u64,
    pub reclaim_delay: i64,
}

impl Settings {
    fn check(&self) -> Result<()> {
        require!(self.fee_bps <= MAXIMUM_FEE_BPS, EscrowError::FeeTooHigh);
        require!(self.maximum_stake > 0, EscrowError::BadStake);
        require!(
            self.reclaim_delay >= MINIMUM_RECLAIM_DELAY && self.reclaim_delay <= MAXIMUM_RECLAIM_DELAY,
            EscrowError::BadReclaimDelay
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// May change the settings, pause, and hold withdrawals.
    pub operator: Pubkey,
    /// Creates, joins (with the player's session key), settles and voids matches.
    pub authority: Pubkey,
    pub fee_vault: Pubkey,
    pub fee_bps: u16,
    pub maximum_stake: u64,
    pub reclaim_delay: i64,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    fn apply(&mut self, settings: &Settings) {
        self.authority = settings.authority;
        self.fee_vault = settings.fee_vault;
        self.fee_bps = settings.fee_bps;
        self.maximum_stake = settings.maximum_stake;
        self.reclaim_delay = settings.reclaim_delay;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    /// Lamports the owner may withdraw or stake.
    pub free: u64,
    /// Lamports staked in matches not yet ended.
    pub locked: u64,
    pub session_key: Pubkey,
    pub session_limit: u64,
    pub session_spent: u64,
    pub session_expiry: i64,
    /// A review hold: no withdrawals before this time.
    pub hold_until: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MatchState {
    Open,
    Settled,
    Void,
}

#[account]
#[derive(InitSpace)]
pub struct Match {
    pub match_id: [u8; 16],
    pub stake: u64,
    pub capacity: u8,
    pub state: MatchState,
    #[max_len(MAXIMUM_PLAYERS)]
    pub players: Vec<Pubkey>,
    /// One bit per player who reclaimed their stake.
    pub reclaimed: u8,
    pub created_at: i64,
    pub reclaim_delay: i64,
    /// The hash of the match's log, recorded with its result.
    pub result_hash: [u8; 32],
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = operator, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OperateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = operator)]
    pub config: Account<'info, Config>,
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct HoldWithdrawals<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = operator)]
    pub config: Account<'info, Config>,
    pub operator: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct OwnVault<'info> {
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 16])]
pub struct CreateMatch<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + Match::INIT_SPACE, seeds = [b"match", match_id.as_ref()], bump)]
    pub game: Account<'info, Match>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"match", game.match_id.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub session_key: Signer<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"match", game.match_id.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseMatch<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"match", game.match_id.as_ref()], bump = game.bump, close = authority)]
    pub game: Account<'info, Match>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    #[account(mut, seeds = [b"match", game.match_id.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[error_code]
pub enum EscrowError {
    #[msg("The amount must be more than zero.")]
    ZeroAmount,
    #[msg("Not enough free balance.")]
    InsufficientFree,
    #[msg("This wallet's withdrawals are held for review.")]
    WithdrawalsHeld,
    #[msg("A hold lasts at most 72 hours.")]
    HoldTooLong,
    #[msg("A session lasts at most a day and must end in the future.")]
    BadSessionExpiry,
    #[msg("That is not this vault's session key.")]
    BadSession,
    #[msg("The session has expired.")]
    SessionExpired,
    #[msg("The session's spending limit is reached.")]
    SessionLimit,
    #[msg("New matches are paused.")]
    Paused,
    #[msg("The stake is zero or above the maximum.")]
    BadStake,
    #[msg("A match holds 2 to 8 players.")]
    BadCapacity,
    #[msg("The match is not open.")]
    MatchNotOpen,
    #[msg("The match is full.")]
    MatchFull,
    #[msg("The player is already in the match.")]
    AlreadyJoined,
    #[msg("The payouts do not match the players or exceed the pot.")]
    BadPayouts,
    #[msg("The fee is above the configured rate.")]
    FeeTooHigh,
    #[msg("The accounts do not match the match's players.")]
    BadAccounts,
    #[msg("A player has already reclaimed their stake.")]
    StakesReclaimed,
    #[msg("The reclaim delay has not passed.")]
    TooEarlyToReclaim,
    #[msg("The player is not in this match.")]
    NotInMatch,
    #[msg("The reclaim delay must be between an hour and a week.")]
    BadReclaimDelay,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
