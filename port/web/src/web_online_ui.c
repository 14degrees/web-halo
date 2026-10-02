/* Browser invite-flow mailbox and game-thread menu integration. */

#include "web_online_ui.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
/* the native dedicated server (port/server) */
#define EMSCRIPTEN_KEEPALIVE
#endif
#include <stdatomic.h>
#include <string.h>

/* This browser adapter is compiled as platform code, so it must not include
the game's cseries headers after the host libc headers.  Keep this boundary
to opaque pointers and the game's scalar ABI. */
struct network_game_client;
struct network_game_server;
struct widget_instance;

void ui_widgets_close_all(void);
struct widget_instance *ui_widget_load_by_name_or_tag(
	const char *name,
	long tag_index,
	struct widget_instance *parent,
	short local_player_index,
	long invoking_widget_tag,
	long focused_child_parent_widget_tag,
	short focused_child_index);
void dispose_global_network_game_server(void);
void dispose_global_network_game_client(void);
struct network_game_server *global_network_game_server_get(void);
struct network_game_client *global_network_game_client_get(void);
unsigned char create_global_network_game_client(void);
void network_game_accept_remote_connections(unsigned char accept_remote_connections);
void player_ui_clear_multiplayer_joins(void);
void player_ui_clear_multiplayer_variant(void);
void player_ui_fast_setup_network_server(void);
long player_ui_get_active_player_profile_index(short local_player_index);
void player_ui_get_active_player_profile(short local_player_index, void *profile);
void player_ui_set_active_player_profile(
	short local_player_index,
	long profile_index,
	void *profile);
unsigned char player_ui_configure_network_server_game(
	long multiplayer_level_index,
	long game_mode_index);
void game_connection_set(short connection);
void main_goto_main_menu(void);
short network_game_client_get_state(struct network_game_client *client, short *state_data);
short network_game_client_get_error(struct network_game_client *client);
unsigned char network_game_client_join_first_available_game(void);
unsigned char network_game_client_add_player(struct network_game_client *client, short controller_index);
unsigned char network_game_client_has_local_player(
	struct network_game_client *client,
	short local_player_index);
void platform_log(const char *format, ...);
/* port/linux/game/network_lobby.c's, for a dedicated host */
long network_lobby_player_count(void);
void network_lobby_start_now(void);
void network_lobby_end_game(void);
unsigned char network_lobby_return_to_pregame(void);
unsigned char network_lobby_restore_pregame_screen(void);
void network_lobby_kill_on_screen(long *sequence, float *x, float *y, unsigned char *on_screen);
long network_lobby_death_sequence(void);
long network_lobby_host_kill_sequence(void);
void const *network_lobby_host_kills(void);
void network_lobby_capture_result(void);
#ifdef HALO_WEB
void network_lobby_preview(float up, float back, float pitch, float yaw);
long network_lobby_background_state(void);
unsigned char network_lobby_background_active(void);
unsigned char network_lobby_background_start(long map_index);
void network_lobby_background_update(float seconds);
void network_lobby_background_stop(void);
void network_lobby_debug_spawn(float seconds);
unsigned char network_lobby_spectating(void);
void network_lobby_spectate(unsigned char on);
void network_lobby_spectate_next(void);
void network_lobby_spectate_update(float seconds);
void network_lobby_spectate_hold_scores(unsigned char hold);
void network_lobby_spectate_target_name(char *out);
#endif
long halo_screen_width(void);

enum
{
	/* network_game_client_get_state(), kept private by its implementation */
	_network_client_searching = 0,
	_network_client_joining,
	_network_client_pregame,
	_network_client_ingame,
	_network_client_postgame,

	/* Native invite joining also gives up after 90 seconds. */
	WEB_ONLINE_JOIN_TIMEOUT_SECONDS = 90,
	/* Retry slowly enough to avoid duplicate in-game queue entries, but soon
	 * enough to recover when a pregame add crosses the match transition. */
	WEB_ONLINE_PLAYER_RETRY_SECONDS = 1,

	_game_connection_local = 0,
	_game_connection_network_client,

	WEB_ONLINE_REQUEST_COMMAND_MASK = 0xff,
	WEB_ONLINE_REQUEST_MAP_SHIFT = 8,
	WEB_ONLINE_REQUEST_MODE_SHIFT = 16,

	/* platform_web_online_host_dedicated's options, packed alike */
	WEB_ONLINE_DEDICATED_MINIMUM_SHIFT = 0,
	WEB_ONLINE_DEDICATED_COUNTDOWN_SHIFT = 8,
	WEB_ONLINE_DEDICATED_POSTGAME_SHIFT = 16,
	/* platform_web_online_set_next_game's: map, mode, and that one is set */
	WEB_ONLINE_NEXT_GAME_VALID_BIT = 1 << 24,

	/* a dedicated host: a game with no other player left in it ends after
	this long; its lobby is put back this long after the client returns to
	the pregame, once the stock map-select screen has taken over; a start
	the server did not act on is asked again after this long */
	WEB_ONLINE_DEDICATED_EMPTY_GAME_SECONDS = 30,
	/* a match ends after this long, so players waiting to join (system link
	admits nobody mid-match) are never kept out for good */
	WEB_ONLINE_DEDICATED_MAXIMUM_GAME_SECONDS = 600,
	WEB_ONLINE_DEDICATED_RESTORE_SECONDS = 1,
	WEB_ONLINE_DEDICATED_START_RETRY_SECONDS = 5,
};

#define WEB_FALSE ((unsigned char)0)
#define WEB_TRUE 1
#define WEB_NONE (-1)

/* Xbox player profiles use eleven UTF-16 code units plus a terminator.  Keep
 * this small ABI mirror local to the browser adapter: including the game's
 * cseries headers after Emscripten's host headers would corrupt libc types. */
struct web_online_player_profile
{
	unsigned short player_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS + 1];
	short primary_color_index;
	unsigned char remainder[22];
};

_Static_assert(sizeof(struct web_online_player_profile) == 0x30,
	"web player profile ABI must remain 0x30 bytes");

/* Command and host options share one atomic word so the game thread can never
observe a new command with map/mode values from a different browser request. */
static atomic_int web_online_requested_request = ATOMIC_VAR_INIT(_web_online_command_none);
static atomic_int web_online_public_state = ATOMIC_VAR_INIT(_web_online_state_idle);
static atomic_int web_online_public_error = ATOMIC_VAR_INIT(_web_online_error_none);
static atomic_int web_online_transport_state = ATOMIC_VAR_INIT(_web_online_transport_disconnected);
static atomic_uint web_online_customization_sequence = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_color = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS];
static unsigned int web_online_applied_customization_sequence;
/* a dedicated host's options, its next game, and what it reports */
static atomic_int web_online_dedicated_options = ATOMIC_VAR_INIT(0);
static atomic_int web_online_next_game = ATOMIC_VAR_INIT(0);
static atomic_int web_online_match_state = ATOMIC_VAR_INIT(_web_online_match_none);
static atomic_int web_online_player_count = ATOMIC_VAR_INIT(0);
static atomic_int web_online_headless = ATOMIC_VAR_INIT(0);
/* a player is waiting to join: end the match so the next one includes them */
static atomic_int web_online_restart_requested = ATOMIC_VAR_INIT(0);
/* (a dedicated host) a new number of players to start with, or -1 */
static atomic_int web_online_minimum_players_request = ATOMIC_VAR_INIT(-1);
/* the latest kill by this machine's player and where its body is on the
screen, in ten-thousandths of the picture (game thread writes, page reads) */
static atomic_int web_online_kill_sequence = ATOMIC_VAR_INIT(0);
static atomic_int web_online_kill_x = ATOMIC_VAR_INIT(5000);
static atomic_int web_online_kill_y = ATOMIC_VAR_INIT(4000);
static atomic_int web_online_kill_on_screen = ATOMIC_VAR_INIT(0);
static atomic_int web_online_screen_width = ATOMIC_VAR_INIT(640);
static atomic_int web_online_death_sequence = ATOMIC_VAR_INIT(0);
static atomic_int web_online_host_kill_sequence = ATOMIC_VAR_INIT(0);
/* seconds until the match starts while counting down, else -1 */
static atomic_int web_online_countdown_remaining = ATOMIC_VAR_INIT(-1);

static struct
{
	int command;
	int setup;
	int join_attempted;
	int join_completed;
	int player_added;
	int player_request_sent;
	int pregame_screen_loaded;
	int wait_frames;
	int host_map_index;
	int host_mode_index;
	float seconds;
	float player_retry_seconds;

	/* a dedicated host (_web_online_command_host_dedicated) */
	int dedicated;
	int minimum_players;
	float countdown_seconds;
	float postgame_seconds;
	/* how long enough players have been in the lobby */
	float lobby_seconds;
	/* until the start is asked (again) */
	float start_retry_seconds;
	/* how long the game has had no other player, and how long it has run */
	float empty_seconds;
	float game_seconds;
	/* how long the carnage report has shown */
	float postgame_shown_seconds;
	/* back from a game: the lobby's screen and countdown to put back */
	int restore_pending;
	float restore_seconds;
	int last_client_state;
	/* this postgame's result is captured (a dedicated host) */
	int result_captured;
} web_online;

static void publish_state(int state)
{
	atomic_store_explicit(&web_online_public_state, state, memory_order_release);
}

static void publish_error(int error)
{
	atomic_store_explicit(&web_online_public_error, error, memory_order_release);
}

static int pack_request(int command, int map_index, int mode_index)
{
	return (command & WEB_ONLINE_REQUEST_COMMAND_MASK) |
		(map_index << WEB_ONLINE_REQUEST_MAP_SHIFT) |
		(mode_index << WEB_ONLINE_REQUEST_MODE_SHIFT);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_request(int command)
{
	if (command < _web_online_command_host || command > _web_online_command_cancel)
		return 0;
	/* Legacy callers that only request hosting get the safe defaults: Battle
	Creek and Slayer. Join/cancel ignore the packed host fields. */
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(command, 0, 0),
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_host_configured(
	int map_index,
	int mode_index)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count)
	{
		return 0;
	}
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(_web_online_command_host, map_index, mode_index),
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_host_dedicated(
	int map_index,
	int mode_index,
	int minimum_players,
	int countdown_seconds,
	int postgame_seconds)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count ||
		minimum_players < 0 || minimum_players > 127 ||
		countdown_seconds < 0 || countdown_seconds > WEB_ONLINE_DEDICATED_MAXIMUM_SECONDS ||
		postgame_seconds < 0 || postgame_seconds > WEB_ONLINE_DEDICATED_MAXIMUM_SECONDS)
	{
		return 0;
	}
	/* The options first: the game thread reads them when it takes the
	request. */
	atomic_store_explicit(
		&web_online_dedicated_options,
		(minimum_players << WEB_ONLINE_DEDICATED_MINIMUM_SHIFT) |
			(countdown_seconds << WEB_ONLINE_DEDICATED_COUNTDOWN_SHIFT) |
			(postgame_seconds << WEB_ONLINE_DEDICATED_POSTGAME_SHIFT),
		memory_order_release);
	atomic_store_explicit(&web_online_next_game, 0, memory_order_release);
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(_web_online_command_host_dedicated, map_index, mode_index),
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_set_next_game(
	int map_index,
	int mode_index)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count)
	{
		return 0;
	}
	atomic_store_explicit(
		&web_online_next_game,
		WEB_ONLINE_NEXT_GAME_VALID_BIT | pack_request(0, map_index, mode_index),
		memory_order_release);
	return 1;
}

/* (a dedicated host) the players the lobby waits for from now on: a
matchmade server waits for its whole roster, then for whoever came once
the load deadline passes */
EMSCRIPTEN_KEEPALIVE int platform_web_online_set_minimum_players(int minimum_players)
{
	if (minimum_players < 0 || minimum_players > 127)
		return 0;
	atomic_store_explicit(&web_online_minimum_players_request, minimum_players, memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE void platform_web_online_request_restart(void)
{
	atomic_store_explicit(&web_online_restart_requested, 1, memory_order_release);
}

EMSCRIPTEN_KEEPALIVE int platform_web_kill_sequence(void)
{
	return atomic_load_explicit(&web_online_kill_sequence, memory_order_acquire);
}

/* A host's kills: how many so far, and the ring of the last 32 (killer and
victim names, 12 bytes each), which the page reads to report them. */
EMSCRIPTEN_KEEPALIVE int platform_web_host_kill_sequence(void)
{
	return atomic_load_explicit(&web_online_host_kill_sequence, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE void const *platform_web_host_kills(void)
{
	return network_lobby_host_kills();
}

EMSCRIPTEN_KEEPALIVE int platform_web_death_sequence(void)
{
	return atomic_load_explicit(&web_online_death_sequence, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_kill_x(void)
{
	return atomic_load_explicit(&web_online_kill_x, memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE int platform_web_kill_y(void)
{
	return atomic_load_explicit(&web_online_kill_y, memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE int platform_web_kill_on_screen(void)
{
	return atomic_load_explicit(&web_online_kill_on_screen, memory_order_relaxed);
}

/* the game picture's columns (480 lines), for placing overlays on it */
EMSCRIPTEN_KEEPALIVE int platform_web_screen_width(void)
{
	return atomic_load_explicit(&web_online_screen_width, memory_order_relaxed);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_countdown_remaining(void)
{
	return atomic_load_explicit(&web_online_countdown_remaining, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_match_state(void)
{
	return atomic_load_explicit(&web_online_match_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_player_count(void)
{
	return atomic_load_explicit(&web_online_player_count, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE void platform_web_online_set_headless(int headless)
{
	atomic_store_explicit(&web_online_headless, headless ? 1 : 0, memory_order_release);
}

int platform_web_online_is_headless(void)
{
	return atomic_load_explicit(&web_online_headless, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_set_player_customization(
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
	int name10)
{
	int i;
	int name_length = 0;
	int name[WEB_ONLINE_PLAYER_NAME_CHARACTERS] =
	{
		name0, name1, name2, name3, name4, name5,
		name6, name7, name8, name9, name10,
	};

	if (color_index < 0 || color_index >= WEB_ONLINE_PLAYER_COLOR_COUNT)
		return 0;

	/* Browser names intentionally use Halo's portable ASCII subset.  Reject a
	 * malformed caller instead of letting control codes reach menu rendering. */
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		if (!name[i])
			break;
		if (name[i] < 0x20 || name[i] > 0x7e)
			return 0;
		name_length++;
	}
	if (!name_length)
		return 0;

	/* Odd versions are writes in progress; even versions are complete. */
	atomic_fetch_add_explicit(
		&web_online_customization_sequence,
		1,
		memory_order_acq_rel);
	atomic_store_explicit(
		&web_online_requested_color,
		color_index,
		memory_order_relaxed);
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		atomic_store_explicit(
			&web_online_requested_name[i],
			i < name_length ? name[i] : 0,
			memory_order_relaxed);
	}
	/* Publishing the even version last commits the mailbox transaction. */
	atomic_fetch_add_explicit(
		&web_online_customization_sequence,
		1,
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_state(void)
{
	return atomic_load_explicit(&web_online_public_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_error(void)
{
	return atomic_load_explicit(&web_online_public_error, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE void platform_web_online_set_transport_state(int state)
{
	if (state < _web_online_transport_disconnected || state > _web_online_transport_failed)
		return;
	atomic_store_explicit(&web_online_transport_state, state, memory_order_release);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_transport_state(void)
{
	return atomic_load_explicit(&web_online_transport_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_client_state(void)
{
	struct network_game_client *client = global_network_game_client_get();

	return client ? network_game_client_get_state(client, NULL) : WEB_NONE;
}

static void apply_requested_player_customization(void)
{
	int i;
	unsigned int sequence;
	unsigned int committed_sequence;
	struct web_online_player_profile profile;

	sequence = atomic_load_explicit(
		&web_online_customization_sequence,
		memory_order_acquire);
	if ((sequence & 1) || sequence == web_online_applied_customization_sequence)
		return;

	player_ui_get_active_player_profile(0, &profile);
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		profile.player_name[i] = (unsigned short)atomic_load_explicit(
			&web_online_requested_name[i],
			memory_order_relaxed);
	}
	profile.player_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS] = 0;
	profile.primary_color_index = (short)atomic_load_explicit(
		&web_online_requested_color,
		memory_order_relaxed);
	committed_sequence = atomic_load_explicit(
		&web_online_customization_sequence,
		memory_order_acquire);
	if (sequence != committed_sequence)
		return;
	player_ui_set_active_player_profile(
		0,
		player_ui_get_active_player_profile_index(0),
		&profile);
	web_online_applied_customization_sequence = sequence;
}

static void clear_multiplayer_joins_and_restore_customization(void)
{
	/* Halo's stock clear also replaces every active player profile with an
	 * unnamed, colour-less default.  Browser hosting/joining deliberately
	 * bypasses the profile picker, so restore the identity the browser posted
	 * before network_game_client_add_player() serializes that profile.  Without
	 * this, the server sees an empty name/NONE colour and assigns random values
	 * such as "Howard" instead. */
	player_ui_clear_multiplayer_joins();
	web_online_applied_customization_sequence = 0;
	apply_requested_player_customization();
}

static void reset_owned_game(void)
{
	/* This mirrors the stock network-game cancel handlers.  Closing the old
	widgets first prevents them from observing the disposed client/server on
	the remainder of this frame. */
	ui_widgets_close_all();
	dispose_global_network_game_server();
	dispose_global_network_game_client();
	network_game_accept_remote_connections(WEB_FALSE);
	player_ui_clear_multiplayer_joins();
	player_ui_clear_multiplayer_variant();
	game_connection_set(_game_connection_local);
	main_goto_main_menu();
}

static void clear_session(void)
{
	memset(&web_online, 0, sizeof(web_online));
}

static void fail_session(int error)
{
	platform_log("web online: session failed (%d)", error);
	if (web_online.setup)
		reset_owned_game();
	clear_session();
	publish_error(error);
	publish_state(_web_online_state_error);
}

static void publish_match(int state)
{
	atomic_store_explicit(&web_online_match_state, state, memory_order_release);
	if (state != _web_online_match_countdown)
		atomic_store_explicit(&web_online_countdown_remaining, -1, memory_order_release);
}

static void begin_request(int command, int map_index, int mode_index)
{
	int dedicated = command == _web_online_command_host_dedicated;

	platform_log("web online: request %s",
		dedicated ? "dedicated host" : command == _web_online_command_host ? "host" : "join");
#ifdef HALO_WEB
	/* the landing's backdrop first goes back to the main menu, where the
	request is set up (it waits for the menu) */
	if (network_lobby_background_active())
	{
		network_lobby_background_stop();
		web_online.wait_frames = 2;
	}
	else
#endif
	if (web_online.command || web_online.setup)
	{
		reset_owned_game();
		clear_session();
		/* main_menu_load() runs near the beginning of the next frame. */
		web_online.wait_frames = 1;
	}
	/* A dedicated host is a host with a driver besides. */
	web_online.command = dedicated ? _web_online_command_host : command;
	web_online.dedicated = dedicated;
	web_online.host_map_index = map_index;
	web_online.host_mode_index = mode_index;
	if (dedicated)
	{
		int options = atomic_load_explicit(&web_online_dedicated_options, memory_order_acquire);

		web_online.minimum_players = (options >> WEB_ONLINE_DEDICATED_MINIMUM_SHIFT) & 0xff;
		web_online.countdown_seconds = (float)((options >> WEB_ONLINE_DEDICATED_COUNTDOWN_SHIFT) & 0xff);
		web_online.postgame_seconds = (float)((options >> WEB_ONLINE_DEDICATED_POSTGAME_SHIFT) & 0xff);
		web_online.last_client_state = WEB_NONE;
		platform_log("web online: dedicated host starts with %d player(s), %g s countdown, %g s postgame",
			web_online.minimum_players, web_online.countdown_seconds, web_online.postgame_seconds);
	}
	publish_match(_web_online_match_none);
	publish_error(_web_online_error_none);
	publish_state(_web_online_state_waiting_for_main_menu);
}

static void cancel_request(void)
{
	if (web_online.command || web_online.setup)
		reset_owned_game();
	clear_session();
	publish_match(_web_online_match_none);
	publish_error(_web_online_error_none);
	publish_state(_web_online_state_idle);
}

/* (a dedicated host) the next game's map and mode, if the browser set one,
on the lobby */
static void apply_next_game(void)
{
	int next = atomic_exchange_explicit(&web_online_next_game, 0, memory_order_acq_rel);
	int map_index;
	int mode_index;

	if (!(next & WEB_ONLINE_NEXT_GAME_VALID_BIT))
		return;
	map_index = (next >> WEB_ONLINE_REQUEST_MAP_SHIFT) & 0xff;
	mode_index = (next >> WEB_ONLINE_REQUEST_MODE_SHIFT) & 0xff;
	if (player_ui_configure_network_server_game(map_index, mode_index))
	{
		web_online.host_map_index = map_index;
		web_online.host_mode_index = mode_index;
		platform_log("web online: next game is map %d mode %d", map_index, mode_index);
	}
	else
	{
		platform_log("web online: could not set the next game (map %d mode %d)", map_index, mode_index);
	}
}

/* (a dedicated host) the driver: starts the game when players are in,
ends one everybody has left, and brings the lobby back after each */
static void update_dedicated(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();
	short client_state;
	long players;
	long others;

	if (!client)
		return;
	{
		int minimum = atomic_exchange_explicit(&web_online_minimum_players_request, -1, memory_order_acq_rel);

		if (minimum >= 0)
		{
			web_online.minimum_players = minimum;
			platform_log("web online: the lobby now waits for %d player(s)", minimum);
		}
	}
	client_state = network_game_client_get_state(client, NULL);
	players = network_lobby_player_count();
	atomic_store_explicit(&web_online_player_count, (int)players, memory_order_release);
	/* the host's own player, once it is in */
	others = players - (web_online.player_added ? 1 : 0);
	if (others < 0)
		others = 0;

	switch (client_state)
	{
	case _network_client_pregame:
		atomic_store_explicit(&web_online_restart_requested, 0, memory_order_release);
		web_online.empty_seconds = 0.0f;
		web_online.postgame_shown_seconds = 0.0f;
		if (web_online.last_client_state == _network_client_postgame)
		{
			web_online.restore_pending = WEB_TRUE;
			web_online.restore_seconds = 0.0f;
		}
		if (web_online.restore_pending)
		{
			/* The stock return from a game shows the host a map-select screen
			with the countdown paused (network_game_reset_to_pregame_ui). Let
			it settle, then put the lobby's screen back, with the next game. */
			web_online.restore_seconds += seconds;
			web_online.lobby_seconds = 0.0f;
			web_online.start_retry_seconds = 0.0f;
			if (web_online.restore_seconds >= (float)WEB_ONLINE_DEDICATED_RESTORE_SECONDS)
			{
				apply_next_game();
				if (network_lobby_restore_pregame_screen())
				{
					web_online.restore_pending = WEB_FALSE;
					platform_log("web online: the lobby is back");
				}
				else
				{
					web_online.restore_seconds = 0.0f;
				}
			}
			publish_match(_web_online_match_lobby);
			break;
		}
		apply_next_game();
		if (others >= web_online.minimum_players)
		{
			web_online.lobby_seconds += seconds;
			publish_match(_web_online_match_countdown);
			{
				float left = web_online.countdown_seconds - web_online.lobby_seconds;
				atomic_store_explicit(&web_online_countdown_remaining,
					left > 0.0f ? (int)(left + 0.999f) : 0, memory_order_release);
			}
			if (web_online.lobby_seconds >= web_online.countdown_seconds)
			{
				web_online.start_retry_seconds -= seconds;
				if (web_online.start_retry_seconds <= 0.0f)
				{
					platform_log("web online: starting the game with %ld player(s)", players);
					network_lobby_start_now();
					web_online.start_retry_seconds = (float)WEB_ONLINE_DEDICATED_START_RETRY_SECONDS;
				}
			}
		}
		else
		{
			web_online.lobby_seconds = 0.0f;
			web_online.start_retry_seconds = 0.0f;
			publish_match(_web_online_match_lobby);
		}
		break;

	case _network_client_ingame:
		web_online.game_seconds += seconds;
		if (web_online.game_seconds >= (float)WEB_ONLINE_DEDICATED_MAXIMUM_GAME_SECONDS)
		{
			platform_log("web online: ending the game at its time limit");
			network_lobby_end_game();
			web_online.game_seconds = 0.0f;
		}
		else if (atomic_exchange_explicit(&web_online_restart_requested, 0, memory_order_acq_rel))
		{
			platform_log("web online: ending the game so a waiting player can join");
			network_lobby_end_game();
			web_online.game_seconds = 0.0f;
		}
		web_online.lobby_seconds = 0.0f;
		web_online.start_retry_seconds = 0.0f;
		web_online.postgame_shown_seconds = 0.0f;
		publish_match(_web_online_match_ingame);
		if (others == 0)
		{
			web_online.empty_seconds += seconds;
			if (web_online.empty_seconds >= (float)WEB_ONLINE_DEDICATED_EMPTY_GAME_SECONDS)
			{
				platform_log("web online: ending the game nobody is left in");
				network_lobby_end_game();
				web_online.empty_seconds = 0.0f;
			}
		}
		else
		{
			web_online.empty_seconds = 0.0f;
		}
		break;

	case _network_client_postgame:
		web_online.game_seconds = 0.0f;
		/* the result, once, before the postgame is reported (the gateway
		pays a wagered team match by it) */
		if (!web_online.result_captured)
		{
			network_lobby_capture_result();
			web_online.result_captured = WEB_TRUE;
		}
		publish_match(_web_online_match_postgame);
		web_online.postgame_shown_seconds += seconds;
		if (web_online.postgame_shown_seconds >= web_online.postgame_seconds)
		{
			if (network_lobby_return_to_pregame())
			{
				platform_log("web online: back to the lobby");
				web_online.postgame_shown_seconds = 0.0f;
				web_online.restore_pending = WEB_TRUE;
				web_online.restore_seconds = 0.0f;
			}
			else
			{
				/* asked again in a couple of seconds */
				web_online.postgame_shown_seconds = web_online.postgame_seconds - 2.0f;
			}
		}
		break;

	default:
		publish_match(_web_online_match_none);
		break;
	}
	if (client_state != _network_client_postgame)
		web_online.result_captured = WEB_FALSE;
	web_online.last_client_state = client_state;
}

static void setup_host(void)
{
	platform_log("web online: opening host lobby");
	clear_multiplayer_joins_and_restore_customization();
	player_ui_clear_multiplayer_variant();
	publish_state(_web_online_state_host_starting);
	player_ui_fast_setup_network_server();
	web_online.setup = WEB_TRUE;
	if (!global_network_game_server_get() || !global_network_game_client_get())
	{
		fail_session(_web_online_error_host_setup_failed);
		return;
	}
	if (!player_ui_configure_network_server_game(
		web_online.host_map_index,
		web_online.host_mode_index))
	{
		fail_session(_web_online_error_host_setup_failed);
		return;
	}
	platform_log("web online: host lobby ready");
	publish_state(_web_online_state_hosting);
}

static void setup_join(void)
{
	platform_log("web online: opening join client");
	dispose_global_network_game_client();
	dispose_global_network_game_server();
	network_game_accept_remote_connections(WEB_FALSE);
	clear_multiplayer_joins_and_restore_customization();
	player_ui_clear_multiplayer_variant();
	web_online.setup = WEB_TRUE;
	if (!create_global_network_game_client())
	{
		fail_session(_web_online_error_client_setup_failed);
		return;
	}
	game_connection_set(_game_connection_network_client);
	publish_state(_web_online_state_join_searching);
}

static void add_primary_player_when_ready(
	struct network_game_client *client,
	float seconds)
{
	if (!client || web_online.player_added)
		return;
#ifdef HALO_WEB
	/* a spectator watches: no player of its own (network_lobby.c) */
	if (network_lobby_spectating())
	{
		web_online.player_added = WEB_TRUE;
		platform_log("web online: watching, with no player");
		return;
	}
#endif
	if (network_game_client_has_local_player(client, 0))
	{
		web_online.player_added = WEB_TRUE;
		platform_log("web online: primary player confirmed");
		return;
	}

	web_online.player_retry_seconds += seconds;
	if (!web_online.player_request_sent ||
		web_online.player_retry_seconds >= WEB_ONLINE_PLAYER_RETRY_SECONDS)
	{
		if (network_game_client_add_player(client, 0))
		{
			platform_log("web online: %s primary player",
				web_online.player_request_sent ? "retrying" : "requesting");
			web_online.player_request_sent = WEB_TRUE;
		}
		web_online.player_retry_seconds = 0.0f;
	}
}

static void update_host(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();

	if (!global_network_game_server_get() || !client)
	{
		/* Backing out through Halo's own UI ends the browser room cleanly. */
		clear_session();
		publish_error(_web_online_error_none);
		publish_state(_web_online_state_idle);
		return;
	}
	web_online.seconds += seconds;
#ifndef HALO_SERVER
	/* (the native dedicated server hosts with no player of its own) */
	if (web_online.seconds >= 0.5f)
		add_primary_player_when_ready(client, seconds);
#endif
	publish_state(_web_online_state_hosting);
	if (web_online.dedicated)
		update_dedicated(seconds);
}

static int load_join_pregame_screen(void)
{
	ui_widgets_close_all();
	return ui_widget_load_by_name_or_tag(
		"ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen",
		WEB_NONE, NULL, WEB_NONE, WEB_NONE, WEB_NONE, WEB_NONE) != NULL;
}

static void update_join(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();
	short client_state;

	web_online.seconds += seconds;
	if (web_online.seconds >= WEB_ONLINE_JOIN_TIMEOUT_SECONDS && !web_online.join_completed)
	{
		fail_session(_web_online_error_join_timed_out);
		return;
	}
	if (!client)
	{
		/* Halo's Back action disposes the client before the browser receives a
		 * cancel command. Treat that local UI action as a clean room exit. */
		clear_session();
		publish_error(_web_online_error_none);
		publish_state(_web_online_state_idle);
		return;
	}
	if (network_game_client_get_error(client) != 0)
	{
		fail_session(_web_online_error_join_failed);
		return;
	}

	client_state = network_game_client_get_state(client, NULL);
	if (!web_online.join_attempted && client_state == _network_client_searching)
	{
		if (network_game_client_join_first_available_game())
		{
			web_online.join_attempted = WEB_TRUE;
			if (!load_join_pregame_screen())
			{
				fail_session(_web_online_error_pregame_screen_failed);
				return;
			}
			web_online.pregame_screen_loaded = WEB_TRUE;
			publish_state(_web_online_state_join_connecting);
		}
		else
		{
			publish_state(_web_online_state_join_searching);
		}
		return;
	}

	if (client_state == _network_client_joining)
	{
		publish_state(_web_online_state_join_connecting);
		return;
	}
	if (client_state == _network_client_pregame ||
		client_state == _network_client_ingame ||
		client_state == _network_client_postgame)
	{
		add_primary_player_when_ready(client, seconds);
		if (!web_online.player_added)
		{
			publish_state(_web_online_state_join_connecting);
			return;
		}
		web_online.join_completed = WEB_TRUE;
		if (!web_online.pregame_screen_loaded && client_state == _network_client_pregame)
		{
			if (!load_join_pregame_screen())
			{
				fail_session(_web_online_error_pregame_screen_failed);
				return;
			}
			web_online.pregame_screen_loaded = WEB_TRUE;
		}
		publish_state(_web_online_state_joined);
		return;
	}

	/* A rejected or disconnected join returns the client to searching. */
	if (web_online.join_attempted && client_state == _network_client_searching)
		fail_session(_web_online_error_join_failed);
}

/* every frame: where the latest kill's body is on the screen */
static void publish_kill(void)
{
	long sequence;
	float x;
	float y;
	unsigned char on_screen;

	network_lobby_kill_on_screen(&sequence, &x, &y, &on_screen);
	atomic_store_explicit(&web_online_kill_x, (int)(x * 10000.0f), memory_order_relaxed);
	atomic_store_explicit(&web_online_kill_y, (int)(y * 10000.0f), memory_order_relaxed);
	atomic_store_explicit(&web_online_kill_on_screen, on_screen ? 1 : 0, memory_order_relaxed);
	atomic_store_explicit(&web_online_kill_sequence, (int)sequence, memory_order_release);
	atomic_store_explicit(&web_online_screen_width, (int)halo_screen_width(), memory_order_relaxed);
	atomic_store_explicit(&web_online_death_sequence, (int)network_lobby_death_sequence(), memory_order_release);
	atomic_store_explicit(&web_online_host_kill_sequence, (int)network_lobby_host_kill_sequence(), memory_order_release);
}

/* ---------- map previews: the page asks, the game thread places the camera */

static atomic_int web_preview_request = ATOMIC_VAR_INIT(0);
/* the landing's backdrop: a map index + 1 to show, -1 to stop, 0 nothing */
static atomic_int web_background_request = ATOMIC_VAR_INIT(0);
static atomic_int web_background_state = ATOMIC_VAR_INIT(0);

/* (the page) play this multiplayer map offline behind the landing */
EMSCRIPTEN_KEEPALIVE void platform_web_background_start(int map_index)
{
	if (map_index >= 0 && map_index < 13)
		atomic_store_explicit(&web_background_request, map_index + 1, memory_order_release);
}

EMSCRIPTEN_KEEPALIVE void platform_web_background_stop(void)
{
	atomic_store_explicit(&web_background_request, -1, memory_order_release);
}

/* 0: none, 1: loading, 2: showing */
EMSCRIPTEN_KEEPALIVE int platform_web_background_state(void)
{
	return atomic_load_explicit(&web_background_state, memory_order_acquire);
}
static float web_preview_settings[4];

EMSCRIPTEN_KEEPALIVE void platform_web_preview(float up, float back, float pitch, float yaw)
{
	web_preview_settings[0] = up;
	web_preview_settings[1] = back;
	web_preview_settings[2] = pitch;
	web_preview_settings[3] = yaw;
	atomic_store_explicit(&web_preview_request, 1, memory_order_release);
}

void web_online_ui_update(int main_menu_loaded, float seconds)
{
#ifdef HALO_WEB
	if (atomic_exchange_explicit(&web_preview_request, 0, memory_order_acq_rel))
		network_lobby_preview(web_preview_settings[0], web_preview_settings[1], web_preview_settings[2], web_preview_settings[3]);
	{
		int request = atomic_load_explicit(&web_background_request, memory_order_acquire);

		if (request < 0)
		{
			atomic_store_explicit(&web_background_request, 0, memory_order_release);
			network_lobby_background_stop();
		}
		/* only from the idle main menu, with nothing else asked of it */
		else if (request > 0 && main_menu_loaded && !web_online.command && !web_online.setup)
		{
			atomic_store_explicit(&web_background_request, 0, memory_order_release);
			network_lobby_background_start(request - 1);
		}
		network_lobby_background_update(seconds);
		network_lobby_debug_spawn(seconds);
		network_lobby_spectate_update(seconds);
		atomic_store_explicit(&web_background_state, (int)network_lobby_background_state(), memory_order_release);
	}
#endif
	int request = atomic_exchange_explicit(
		&web_online_requested_request,
		_web_online_command_none,
		memory_order_acq_rel);
	int command = request & WEB_ONLINE_REQUEST_COMMAND_MASK;
	int map_index = (request >> WEB_ONLINE_REQUEST_MAP_SHIFT) & 0xff;
	int mode_index = (request >> WEB_ONLINE_REQUEST_MODE_SHIFT) & 0xff;

	/* Browser calls only publish atomics.  Apply the selected identity here,
	 * before host/join can build its network_player from the active profile. */
	apply_requested_player_customization();
	publish_kill();

	if (command == _web_online_command_cancel)
	{
		cancel_request();
		return;
	}
	if (command == _web_online_command_host || command == _web_online_command_join ||
		command == _web_online_command_host_dedicated)
	{
		begin_request(command, map_index, mode_index);
	}

	if (!web_online.command)
		return;
	if (web_online.wait_frames > 0)
	{
		web_online.wait_frames--;
		return;
	}
	if (!web_online.setup)
	{
		if (!main_menu_loaded)
		{
			publish_state(_web_online_state_waiting_for_main_menu);
			return;
		}
		if (web_online.command == _web_online_command_host)
			setup_host();
		else
			setup_join();
		return;
	}

	if (web_online.command == _web_online_command_host)
		update_host(seconds);
	else
		update_join(seconds);
}

/* ---------- a wagered match's money, for the scoreboard

The page (online_client.js) writes each player's name and their running SOL
total into the staging table, then commits it; the game thread's scoreboard
looks a row's player up by name. A sequence lock keeps the game thread from
reading a table half written: odd while the page copies in. */

#define WEB_WAGER_ROWS 16
#define WEB_WAGER_NAME 12
#define WEB_WAGER_LABEL 12
#define WEB_WAGER_FOOTER 48

struct web_wager_table
{
	struct
	{
		char name[WEB_WAGER_NAME];
		char label[WEB_WAGER_LABEL];
	} rows[WEB_WAGER_ROWS];
	char footer[WEB_WAGER_FOOTER];
};

static struct web_wager_table web_wager_staging;
static struct web_wager_table web_wager_live;
static int web_wager_count;
static atomic_int web_wager_sequence = ATOMIC_VAR_INIT(0);

/* where the page writes the table: rows of a 12-byte name and a 12-byte
label, then a 48-byte footer, each NUL-terminated */
#ifdef HALO_WEB
/* Watching (a spectator): on before joining, off to play; the next player
to follow; whose view it is; the scores held up (Tab) */
EMSCRIPTEN_KEEPALIVE void platform_web_spectate(int on)
{
	network_lobby_spectate(on ? 1 : 0);
}

EMSCRIPTEN_KEEPALIVE void platform_web_spectate_next(void)
{
	network_lobby_spectate_next();
}

EMSCRIPTEN_KEEPALIVE char const *platform_web_spectate_target(void)
{
	static char name[16];

	network_lobby_spectate_target_name(name);
	return name;
}

EMSCRIPTEN_KEEPALIVE void platform_web_spectate_scores(int hold)
{
	network_lobby_spectate_hold_scores(hold ? 1 : 0);
}
#endif

/* The scores, while the scoreboard shows (JSON: network_lobby.c); the page
draws them (port/web/online_client.js) */
long network_lobby_scoreboard_json(char *out, long size);

EMSCRIPTEN_KEEPALIVE char const *platform_web_scoreboard(void)
{
	static char buffer[6144];

	network_lobby_scoreboard_json(buffer, sizeof(buffer));
	return buffer;
}

EMSCRIPTEN_KEEPALIVE void *platform_web_wager_staging(void)
{
	return &web_wager_staging;
}

/* publish the staging table's first `count` rows (0: not a wagered match) */
EMSCRIPTEN_KEEPALIVE void platform_web_wager_commit(int count)
{
	if (count < 0)
		count = 0;
	if (count > WEB_WAGER_ROWS)
		count = WEB_WAGER_ROWS;
	atomic_fetch_add_explicit(&web_wager_sequence, 1, memory_order_acq_rel);
	memcpy(&web_wager_live, &web_wager_staging, sizeof(web_wager_live));
	for (int index = 0; index < WEB_WAGER_ROWS; index++)
	{
		web_wager_live.rows[index].name[WEB_WAGER_NAME - 1] = 0;
		web_wager_live.rows[index].label[WEB_WAGER_LABEL - 1] = 0;
	}
	web_wager_live.footer[WEB_WAGER_FOOTER - 1] = 0;
	web_wager_count = count;
	atomic_fetch_add_explicit(&web_wager_sequence, 1, memory_order_release);
}

/* A consistent copy of the live table, or 0 rows if the page was writing. */
static int web_wager_snapshot(struct web_wager_table *table)
{
	for (int attempt = 0; attempt < 4; attempt++)
	{
		int before = atomic_load_explicit(&web_wager_sequence, memory_order_acquire);
		int count;

		if (before & 1)
			continue;
		count = web_wager_count;
		memcpy(table, &web_wager_live, sizeof(*table));
		atomic_thread_fence(memory_order_acquire);
		if (atomic_load_explicit(&web_wager_sequence, memory_order_relaxed) == before)
			return count;
	}
	return 0;
}

/* (game thread) a player's SOL label by their name, e.g. "+0.020"; FALSE
when the match is not wagered or the player is not in it */
int web_wager_label(char const *name, char *label, int label_size)
{
	struct web_wager_table table;
	int count = web_wager_snapshot(&table);

	for (int index = 0; index < count; index++)
	{
		if (strncmp(table.rows[index].name, name, WEB_WAGER_NAME) == 0)
		{
			strncpy(label, table.rows[index].label, (size_t)label_size - 1);
			label[label_size - 1] = 0;
			return 1;
		}
	}
	return 0;
}

/* (game thread) the match's pot for the scoreboard, e.g. "0.100", and
whether this is a wagered match at all */
int web_wager_footer(char *text, int text_size)
{
	struct web_wager_table table;
	int count = web_wager_snapshot(&table);

	if (count <= 0)
		return 0;
	strncpy(text, table.footer, (size_t)text_size - 1);
	text[text_size - 1] = 0;
	return 1;
}
