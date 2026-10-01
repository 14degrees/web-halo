/* Browser invite-flow commands and game-side state.

The JavaScript shell runs on the browser thread while Halo runs on an
Emscripten pthread.  The exported functions in this header therefore only
touch atomics.  web_online_ui_update() consumes those values on Halo's game
thread and is the only entry point that changes menus or network state. */

#ifndef HALO_WEB_ONLINE_UI_H
#define HALO_WEB_ONLINE_UI_H

enum web_online_command
{
	_web_online_command_none = 0,
	_web_online_command_host,
	_web_online_command_join,
	_web_online_command_cancel,
	/* a dedicated host: a server-run browser that keeps a public lobby open,
	starts its games when players are in, and brings the lobby back after
	each (platform_web_online_host_dedicated) */
	_web_online_command_host_dedicated,
};

enum web_online_multiplayer_level
{
	_web_online_multiplayer_level_battle_creek = 0,
	_web_online_multiplayer_level_sidewinder,
	_web_online_multiplayer_level_damnation,
	_web_online_multiplayer_level_rat_race,
	_web_online_multiplayer_level_prisoner,
	_web_online_multiplayer_level_hang_em_high,
	_web_online_multiplayer_level_chill_out,
	_web_online_multiplayer_level_derelict,
	_web_online_multiplayer_level_boarding_action,
	_web_online_multiplayer_level_blood_gulch,
	_web_online_multiplayer_level_wizard,
	_web_online_multiplayer_level_chiron_tl34,
	_web_online_multiplayer_level_longest,
	_web_online_multiplayer_level_count,
};

enum web_online_game_mode
{
	_web_online_game_mode_slayer = 0,
	_web_online_game_mode_team_slayer,
	_web_online_game_mode_ctf,
	_web_online_game_mode_oddball,
	_web_online_game_mode_king,
	_web_online_game_mode_race,
	_web_online_game_mode_count,
};

enum web_online_state
{
	_web_online_state_idle = 0,
	_web_online_state_waiting_for_main_menu,
	_web_online_state_host_starting,
	_web_online_state_hosting,
	_web_online_state_join_searching,
	_web_online_state_join_connecting,
	_web_online_state_joined,
	_web_online_state_error,
};

enum web_online_error
{
	_web_online_error_none = 0,
	_web_online_error_host_setup_failed,
	_web_online_error_client_setup_failed,
	_web_online_error_pregame_screen_failed,
	_web_online_error_join_failed,
	_web_online_error_join_timed_out,
};

enum web_online_transport_state
{
	_web_online_transport_disconnected = 0,
	_web_online_transport_connecting,
	_web_online_transport_connected,
	_web_online_transport_failed,
};

/* where a dedicated host's game is (platform_web_online_get_match_state) */
enum web_online_match_state
{
	_web_online_match_none = 0,
	/* the lobby, waiting for players */
	_web_online_match_lobby,
	/* enough players are in: the game starts when the countdown ends */
	_web_online_match_countdown,
	_web_online_match_ingame,
	/* the carnage report; the lobby comes back after a pause */
	_web_online_match_postgame,
};

enum
{
	WEB_ONLINE_DEDICATED_MAXIMUM_SECONDS = 255,
};

enum
{
	WEB_ONLINE_PLAYER_NAME_CHARACTERS = 11,
	WEB_ONLINE_PLAYER_COLOR_COUNT = 18,
};

/* JavaScript-facing, atomic-only API. */
int platform_web_online_request(int command);
int platform_web_online_host_configured(int map_index, int mode_index);
int platform_web_online_set_player_customization(
	int color_index,
	int name0,
	int name1,
	int name2,
	int name3,
	int name4,
	int name5,
	int name6,
	int name7,
	int name8,
	int name9,
	int name10);
int platform_web_online_get_state(void);
int platform_web_online_get_error(void);
void platform_web_online_set_transport_state(int state);
int platform_web_online_get_transport_state(void);

/* A dedicated host. minimum_players counts the players besides the host's
own (0: start alone, which the art capture tool uses); a match ends after
ten minutes; the game starts countdown_seconds after that many are in the lobby,
and the lobby returns postgame_seconds after a game ends. */
int platform_web_online_host_dedicated(
	int map_index,
	int mode_index,
	int minimum_players,
	int countdown_seconds,
	int postgame_seconds);
/* The next game's map and mode: applied when the lobby is next open. */
int platform_web_online_set_next_game(int map_index, int mode_index);
/* A player is waiting to join: end the running match so the next one
includes them (system link admits nobody mid-match). */
void platform_web_online_request_restart(void);
/* Seconds until the match starts while counting down, else -1. */
int platform_web_online_get_countdown_remaining(void);
int platform_web_online_get_match_state(void);
/* The players in the network game, the host's own among them. */
int platform_web_online_get_player_count(void);
/* Before the game starts (Module.onRuntimeInitialized): draw nothing, as a
server has no screen. Read by the platform layer when it seeds settings. */
void platform_web_online_set_headless(int headless);
int platform_web_online_is_headless(void);
/* (a dedicated host) the players the lobby waits for from now on */
int platform_web_online_set_minimum_players(int minimum_players);

/* Called on Halo's game thread once per frame. */
void web_online_ui_update(int main_menu_loaded, float seconds);

#endif /* HALO_WEB_ONLINE_UI_H */
