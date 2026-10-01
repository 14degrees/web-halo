//! The escrow's rules, checked against the built program in LiteSVM. Build
//! it first (`anchor build`), then `cargo test`.

use anchor_lang::{InstructionData, ToAccountMetas};
use halo_escrow::{Settings, Vault, Match, MatchState};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SOL: u64 = 1_000_000_000;
const STAKE: u64 = SOL / 20; // 0.05 SOL
const RECLAIM_DELAY: i64 = 24 * 60 * 60;

struct World {
    svm: LiteSVM,
    operator: Keypair,
    authority: Keypair,
    fee_vault: Pubkey,
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &halo_escrow::ID).0
}

fn vault_address(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", owner.as_ref()], &halo_escrow::ID).0
}

fn match_address(id: &[u8; 16]) -> Pubkey {
    Pubkey::find_program_address(&[b"match", id.as_ref()], &halo_escrow::ID).0
}

impl World {
    fn new() -> World {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(halo_escrow::ID, concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/halo_escrow.so"))
            .expect("build the program first: anchor build");
        let operator = Keypair::new();
        let authority = Keypair::new();
        let fee_vault = Keypair::new().pubkey();
        svm.airdrop(&operator.pubkey(), 10 * SOL).unwrap();
        svm.airdrop(&authority.pubkey(), 10 * SOL).unwrap();
        svm.airdrop(&fee_vault, SOL).unwrap();
        let mut world = World { svm, operator, authority, fee_vault };
        world.set_time(1_800_000_000);
        let settings = world.settings(500);
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::Initialize {
                config: config_address(),
                operator: world.operator.pubkey(),
                system_program: solana_system_interface::program::ID,
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::Initialize { settings }.data(),
        };
        let operator = world.operator.insecure_clone();
        world.send(ix, &[&operator]).unwrap();
        world
    }

    fn settings(&self, fee_bps: u16) -> Settings {
        Settings {
            authority: self.authority.pubkey(),
            fee_vault: self.fee_vault,
            fee_bps,
            maximum_stake: SOL / 10,
            reclaim_delay: RECLAIM_DELAY,
        }
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer), signers, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|failure| format!("{:?}", failure.err))
    }

    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map(|account| account.lamports).unwrap_or(0)
    }

    fn vault(&self, owner: &Pubkey) -> Vault {
        let account = self.svm.get_account(&vault_address(owner)).unwrap();
        anchor_lang::AccountDeserialize::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn game(&self, id: &[u8; 16]) -> Match {
        let account = self.svm.get_account(&match_address(id)).unwrap();
        anchor_lang::AccountDeserialize::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    /// A player with a funded vault and a session key.
    fn player(&mut self, deposit: u64, session_limit: u64) -> (Keypair, Keypair) {
        let owner = Keypair::new();
        let session = Keypair::new();
        self.svm.airdrop(&owner.pubkey(), 2 * SOL).unwrap();
        let open = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::OpenVault {
                vault: vault_address(&owner.pubkey()),
                owner: owner.pubkey(),
                system_program: solana_system_interface::program::ID,
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::OpenVault {}.data(),
        };
        self.send(open, &[&owner]).unwrap();
        if deposit > 0 {
            self.deposit(&owner, deposit).unwrap();
        }
        let expiry = self.now() + 12 * 60 * 60;
        self.open_session(&owner, session.pubkey(), session_limit, expiry).unwrap();
        (owner, session)
    }

    fn deposit(&mut self, owner: &Keypair, lamports: u64) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::Deposit {
                vault: vault_address(&owner.pubkey()),
                owner: owner.pubkey(),
                system_program: solana_system_interface::program::ID,
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::Deposit { lamports }.data(),
        };
        self.send(ix, &[owner])
    }

    fn withdraw(&mut self, owner: &Keypair, lamports: u64) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::Withdraw { vault: vault_address(&owner.pubkey()), owner: owner.pubkey() }
                .to_account_metas(None),
            data: halo_escrow::instruction::Withdraw { lamports }.data(),
        };
        self.send(ix, &[owner])
    }

    fn open_session(&mut self, owner: &Keypair, session_key: Pubkey, limit: u64, expiry: i64) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::OwnVault { vault: vault_address(&owner.pubkey()), owner: owner.pubkey() }
                .to_account_metas(None),
            data: halo_escrow::instruction::OpenSession { session_key, limit, expiry }.data(),
        };
        self.send(ix, &[owner])
    }

    fn create_match(&mut self, id: [u8; 16], stake: u64, capacity: u8) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::CreateMatch {
                config: config_address(),
                game: match_address(&id),
                authority: self.authority.pubkey(),
                system_program: solana_system_interface::program::ID,
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::CreateMatch { match_id: id, stake, capacity }.data(),
        };
        let authority = self.authority.insecure_clone();
        self.send(ix, &[&authority])
    }

    fn join(&mut self, id: [u8; 16], owner: &Pubkey, session: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::JoinMatch {
                config: config_address(),
                game: match_address(&id),
                vault: vault_address(owner),
                session_key: session.pubkey(),
                authority: self.authority.pubkey(),
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::JoinMatch {}.data(),
        };
        let authority = self.authority.insecure_clone();
        self.send(ix, &[&authority, session])
    }

    fn settle_accounts(&self, id: [u8; 16], owners: &[Pubkey], fee_vault: Option<Pubkey>) -> Vec<solana_instruction::AccountMeta> {
        let mut accounts = halo_escrow::accounts::Settle {
            config: config_address(),
            game: match_address(&id),
            authority: self.authority.pubkey(),
        }
        .to_account_metas(None);
        for owner in owners {
            accounts.push(solana_instruction::AccountMeta::new(vault_address(owner), false));
        }
        if let Some(fee_vault) = fee_vault {
            accounts.push(solana_instruction::AccountMeta::new(fee_vault, false));
        }
        accounts
    }

    fn settle(&mut self, id: [u8; 16], owners: &[Pubkey], payouts: Vec<u64>) -> Result<(), String> {
        let fee_vault = self.fee_vault;
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: self.settle_accounts(id, owners, Some(fee_vault)),
            data: halo_escrow::instruction::Settle { payouts, result_hash: [7; 32] }.data(),
        };
        let authority = self.authority.insecure_clone();
        self.send(ix, &[&authority])
    }

    fn void(&mut self, id: [u8; 16], owners: &[Pubkey]) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: self.settle_accounts(id, owners, None),
            data: halo_escrow::instruction::VoidMatch {}.data(),
        };
        let authority = self.authority.insecure_clone();
        self.send(ix, &[&authority])
    }

    fn reclaim(&mut self, id: [u8; 16], owner: &Keypair) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::Reclaim {
                game: match_address(&id),
                vault: vault_address(&owner.pubkey()),
                owner: owner.pubkey(),
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::Reclaim {}.data(),
        };
        self.send(ix, &[owner])
    }

    fn operate(&mut self, data: Vec<u8>) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::OperateConfig { config: config_address(), operator: self.operator.pubkey() }
                .to_account_metas(None),
            data,
        };
        let operator = self.operator.insecure_clone();
        self.send(ix, &[&operator])
    }

    fn hold(&mut self, owner: &Pubkey, until: i64) -> Result<(), String> {
        let ix = Instruction {
            program_id: halo_escrow::ID,
            accounts: halo_escrow::accounts::HoldWithdrawals {
                config: config_address(),
                operator: self.operator.pubkey(),
                vault: vault_address(owner),
            }
            .to_account_metas(None),
            data: halo_escrow::instruction::HoldWithdrawals { until }.data(),
        };
        let operator = self.operator.insecure_clone();
        self.send(ix, &[&operator])
    }

    /// Every vault's lamports: rent plus free plus locked, exactly.
    fn assert_vault_backed(&self, owner: &Pubkey) {
        let vault = self.vault(owner);
        let account = self.svm.get_account(&vault_address(owner)).unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(account.data.len());
        assert_eq!(account.lamports, rent + vault.free + vault.locked, "vault lamports must equal rent + free + locked");
    }
}

#[test]
fn a_match_pays_the_winners_and_the_fee_and_moves_nothing_else() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    let id = [1; 16];
    world.create_match(id, STAKE, 2).unwrap();
    world.join(id, &a.pubkey(), &a_session).unwrap();
    world.join(id, &b.pubkey(), &b_session).unwrap();
    assert_eq!(world.vault(&a.pubkey()).locked, STAKE);
    assert_eq!(world.vault(&a.pubkey()).free, SOL - STAKE);

    let fee_before = world.lamports(&world.fee_vault.clone());
    let total_before = world.lamports(&vault_address(&a.pubkey())) + world.lamports(&vault_address(&b.pubkey())) + fee_before;
    // a wins the pot of 0.1 SOL less 5%
    let pot = 2 * STAKE;
    let fee = pot * 5 / 100;
    world.settle(id, &[a.pubkey(), b.pubkey()], vec![pot - fee, 0]).unwrap();

    assert_eq!(world.vault(&a.pubkey()).free, SOL - STAKE + pot - fee);
    assert_eq!(world.vault(&b.pubkey()).free, SOL - STAKE);
    assert_eq!(world.vault(&a.pubkey()).locked, 0);
    assert_eq!(world.vault(&b.pubkey()).locked, 0);
    assert_eq!(world.lamports(&world.fee_vault.clone()), fee_before + fee);
    let total_after = world.lamports(&vault_address(&a.pubkey())) + world.lamports(&vault_address(&b.pubkey()))
        + world.lamports(&world.fee_vault.clone());
    assert_eq!(total_before, total_after, "settling moves SOL, never makes or loses it");
    world.assert_vault_backed(&a.pubkey());
    world.assert_vault_backed(&b.pubkey());
    assert!(world.game(&id).state == MatchState::Settled);
    assert_eq!(world.game(&id).result_hash, [7; 32]);
}

#[test]
fn a_match_settles_once() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    let id = [2; 16];
    world.create_match(id, STAKE, 2).unwrap();
    world.join(id, &a.pubkey(), &a_session).unwrap();
    world.join(id, &b.pubkey(), &b_session).unwrap();
    world.settle(id, &[a.pubkey(), b.pubkey()], vec![2 * STAKE, 0]).unwrap();
    assert!(world.settle(id, &[a.pubkey(), b.pubkey()], vec![2 * STAKE, 0]).is_err());
    assert!(world.void(id, &[a.pubkey(), b.pubkey()]).is_err());
}

#[test]
fn a_settle_cannot_pay_more_than_the_pot_or_take_more_than_the_fee() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    let id = [3; 16];
    world.create_match(id, STAKE, 2).unwrap();
    world.join(id, &a.pubkey(), &a_session).unwrap();
    world.join(id, &b.pubkey(), &b_session).unwrap();
    let pot = 2 * STAKE;
    let owners = [a.pubkey(), b.pubkey()];
    // more than the pot
    assert!(world.settle(id, &owners, vec![pot, 1]).is_err());
    // a 6% fee when the rate is 5%
    assert!(world.settle(id, &owners, vec![pot - pot * 6 / 100, 0]).is_err());
    // a payout per player is required
    assert!(world.settle(id, &owners, vec![pot]).is_err());
    // vaults in the wrong order pay the wrong players
    let fee_vault = world.fee_vault;
    let ix = Instruction {
        program_id: halo_escrow::ID,
        accounts: world.settle_accounts(id, &[b.pubkey(), a.pubkey()], Some(fee_vault)),
        data: halo_escrow::instruction::Settle { payouts: vec![pot, 0], result_hash: [0; 32] }.data(),
    };
    let authority = world.authority.insecure_clone();
    assert!(world.send(ix, &[&authority]).is_err());
    // the fee goes to the configured fee vault only
    let ix = Instruction {
        program_id: halo_escrow::ID,
        accounts: world.settle_accounts(id, &owners, Some(Keypair::new().pubkey())),
        data: halo_escrow::instruction::Settle { payouts: vec![pot - pot / 20, 0], result_hash: [0; 32] }.data(),
    };
    assert!(world.send(ix, &[&authority]).is_err());
    // only the authority settles
    let stranger = Keypair::new();
    world.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let mut accounts = world.settle_accounts(id, &owners, Some(fee_vault));
    accounts[2] = solana_instruction::AccountMeta::new_readonly(stranger.pubkey(), true);
    let ix = Instruction {
        program_id: halo_escrow::ID,
        accounts,
        data: halo_escrow::instruction::Settle { payouts: vec![pot, 0], result_hash: [0; 32] }.data(),
    };
    assert!(world.send(ix, &[&stranger]).is_err());
    // and the honest settle still works
    world.settle(id, &owners, vec![pot / 2, pot / 2]).unwrap();
}

#[test]
fn joining_needs_the_session_key_and_the_authority_within_the_limit() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, 2 * STAKE);
    world.create_match([4; 16], STAKE, 2).unwrap();
    world.create_match([5; 16], STAKE, 2).unwrap();
    world.create_match([6; 16], STAKE, 2).unwrap();
    // a key that is not the session key
    assert!(world.join([4; 16], &a.pubkey(), &Keypair::new()).is_err());
    // the authority alone cannot join anyone: the session key must sign
    let ix = Instruction {
        program_id: halo_escrow::ID,
        accounts: halo_escrow::accounts::JoinMatch {
            config: config_address(),
            game: match_address(&[4; 16]),
            vault: vault_address(&a.pubkey()),
            session_key: world.authority.pubkey(),
            authority: world.authority.pubkey(),
        }
        .to_account_metas(None),
        data: halo_escrow::instruction::JoinMatch {}.data(),
    };
    let authority = world.authority.insecure_clone();
    assert!(world.send(ix, &[&authority]).is_err());
    // the session key alone cannot join either
    let mut accounts = halo_escrow::accounts::JoinMatch {
        config: config_address(),
        game: match_address(&[4; 16]),
        vault: vault_address(&a.pubkey()),
        session_key: a_session.pubkey(),
        authority: world.authority.pubkey(),
    }
    .to_account_metas(None);
    accounts[4].is_signer = false;
    world.svm.airdrop(&a_session.pubkey(), SOL).unwrap();
    let ix = Instruction { program_id: halo_escrow::ID, accounts, data: halo_escrow::instruction::JoinMatch {}.data() };
    assert!(world.send(ix, &[&a_session]).is_err());
    // two joins fit the limit of two stakes; the third does not
    world.join([4; 16], &a.pubkey(), &a_session).unwrap();
    assert!(world.join([4; 16], &a.pubkey(), &a_session).is_err(), "no joining the same match twice");
    world.join([5; 16], &a.pubkey(), &a_session).unwrap();
    assert!(world.join([6; 16], &a.pubkey(), &a_session).is_err(), "over the session limit");
    // an expired session joins nothing
    let (b, b_session) = world.player(SOL, SOL);
    let now = world.now();
    world.set_time(now + 13 * 60 * 60);
    assert!(world.join([6; 16], &b.pubkey(), &b_session).is_err(), "expired session");
}

#[test]
fn joining_needs_the_stake_in_the_free_balance_and_a_place_in_the_match() {
    let mut world = World::new();
    let (poor, poor_session) = world.player(STAKE / 2, SOL);
    world.create_match([7; 16], STAKE, 2).unwrap();
    assert!(world.join([7; 16], &poor.pubkey(), &poor_session).is_err());
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    let (c, c_session) = world.player(SOL, SOL);
    world.join([7; 16], &a.pubkey(), &a_session).unwrap();
    world.join([7; 16], &b.pubkey(), &b_session).unwrap();
    assert!(world.join([7; 16], &c.pubkey(), &c_session).is_err(), "the match is full");
    // a stake above the maximum
    assert!(world.create_match([8; 16], SOL, 2).is_err());
}

#[test]
fn locked_stakes_cannot_be_withdrawn_and_free_balance_always_can() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    world.create_match([9; 16], STAKE, 2).unwrap();
    world.join([9; 16], &a.pubkey(), &a_session).unwrap();
    world.join([9; 16], &b.pubkey(), &b_session).unwrap();
    assert!(world.withdraw(&a, SOL).is_err(), "the stake is locked");
    let wallet_before = world.lamports(&a.pubkey());
    world.withdraw(&a, SOL - STAKE).unwrap();
    assert!(world.lamports(&a.pubkey()) > wallet_before + SOL - STAKE - SOL / 1000);
    world.assert_vault_backed(&a.pubkey());
    // pausing stops matches, not withdrawals
    world.operate(halo_escrow::instruction::SetPaused { paused: true }.data()).unwrap();
    assert!(world.create_match([10; 16], STAKE, 2).is_err());
    world.void([9; 16], &[a.pubkey(), b.pubkey()]).unwrap();
    world.withdraw(&a, STAKE).unwrap();
    world.withdraw(&b, SOL).unwrap();
    world.assert_vault_backed(&a.pubkey());
    world.assert_vault_backed(&b.pubkey());
}

#[test]
fn a_void_returns_every_stake() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    world.create_match([11; 16], STAKE, 2).unwrap();
    world.join([11; 16], &a.pubkey(), &a_session).unwrap();
    world.join([11; 16], &b.pubkey(), &b_session).unwrap();
    world.void([11; 16], &[a.pubkey(), b.pubkey()]).unwrap();
    assert_eq!(world.vault(&a.pubkey()).free, SOL);
    assert_eq!(world.vault(&b.pubkey()).free, SOL);
    assert!(world.game(&[11; 16]).state == MatchState::Void);
    world.assert_vault_backed(&a.pubkey());
}

#[test]
fn players_reclaim_an_unsettled_match_after_the_delay_without_us() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    world.create_match([12; 16], STAKE, 2).unwrap();
    world.join([12; 16], &a.pubkey(), &a_session).unwrap();
    world.join([12; 16], &b.pubkey(), &b_session).unwrap();
    assert!(world.reclaim([12; 16], &a).is_err(), "too early");
    let now = world.now();
    world.set_time(now + RECLAIM_DELAY + 1);
    world.reclaim([12; 16], &a).unwrap();
    assert!(world.reclaim([12; 16], &a).is_err(), "only once");
    assert_eq!(world.vault(&a.pubkey()).free, SOL);
    // a reclaimed match can no longer settle
    assert!(world.settle([12; 16], &[a.pubkey(), b.pubkey()], vec![2 * STAKE, 0]).is_err());
    world.reclaim([12; 16], &b).unwrap();
    assert!(world.game(&[12; 16]).state == MatchState::Void);
    // a stranger reclaims nothing
    let (c, _) = world.player(SOL, SOL);
    assert!(world.reclaim([12; 16], &c).is_err());
}

#[test]
fn a_review_hold_lasts_at_most_72_hours_and_lifts_by_itself() {
    let mut world = World::new();
    let (a, _) = world.player(SOL, SOL);
    let now = world.now();
    assert!(world.hold(&a.pubkey(), now + 73 * 60 * 60).is_err());
    world.hold(&a.pubkey(), now + 72 * 60 * 60).unwrap();
    assert!(world.withdraw(&a, STAKE).is_err());
    world.set_time(now + 72 * 60 * 60);
    world.withdraw(&a, STAKE).unwrap();
}

#[test]
fn the_fee_has_a_hard_cap_and_only_the_operator_changes_settings() {
    let mut world = World::new();
    let too_high = world.settings(1_001);
    assert!(world.operate(halo_escrow::instruction::UpdateConfig { settings: too_high }.data()).is_err());
    let settings = world.settings(300);
    world.operate(halo_escrow::instruction::UpdateConfig { settings }.data()).unwrap();
    let stranger = Keypair::new();
    world.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let ix = Instruction {
        program_id: halo_escrow::ID,
        accounts: halo_escrow::accounts::OperateConfig { config: config_address(), operator: stranger.pubkey() }
            .to_account_metas(None),
        data: halo_escrow::instruction::SetPaused { paused: true }.data(),
    };
    assert!(world.send(ix, &[&stranger]).is_err());
}

#[test]
fn a_four_player_team_match_splits_the_pot() {
    let mut world = World::new();
    let players: Vec<(Keypair, Keypair)> = (0..4).map(|_| world.player(SOL, SOL)).collect();
    let id = [13; 16];
    world.create_match(id, STAKE, 4).unwrap();
    for (owner, session) in &players {
        world.join(id, &owner.pubkey(), session).unwrap();
    }
    let pot = 4 * STAKE;
    let fee = pot * 5 / 100;
    let share = (pot - fee) / 2;
    let owners: Vec<Pubkey> = players.iter().map(|(owner, _)| owner.pubkey()).collect();
    world.settle(id, &owners, vec![share, share, 0, 0]).unwrap();
    assert_eq!(world.vault(&owners[0]).free, SOL - STAKE + share);
    assert_eq!(world.vault(&owners[2]).free, SOL - STAKE);
    for owner in &owners {
        world.assert_vault_backed(owner);
    }
}

#[test]
fn an_ended_match_closes_and_refunds_its_rent_but_an_open_one_does_not() {
    let mut world = World::new();
    let (a, a_session) = world.player(SOL, SOL);
    let (b, b_session) = world.player(SOL, SOL);
    let id = [14; 16];
    world.create_match(id, STAKE, 2).unwrap();
    world.join(id, &a.pubkey(), &a_session).unwrap();
    world.join(id, &b.pubkey(), &b_session).unwrap();
    let close = |world: &World| Instruction {
        program_id: halo_escrow::ID,
        accounts: halo_escrow::accounts::CloseMatch {
            config: config_address(),
            game: match_address(&id),
            authority: world.authority.pubkey(),
        }
        .to_account_metas(None),
        data: halo_escrow::instruction::CloseMatch {}.data(),
    };
    let authority = world.authority.insecure_clone();
    let ix = close(&world);
    assert!(world.send(ix, &[&authority]).is_err(), "an open match stays");
    world.settle(id, &[a.pubkey(), b.pubkey()], vec![STAKE, STAKE]).unwrap();
    let before = world.lamports(&authority.pubkey());
    let ix = close(&world);
    world.send(ix, &[&authority]).unwrap();
    assert!(world.svm.get_account(&match_address(&id)).map(|account| account.lamports == 0).unwrap_or(true));
    assert!(world.lamports(&authority.pubkey()) > before, "the rent comes back");
}
