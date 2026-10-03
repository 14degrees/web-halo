/*
NETWORK_LOBBY.C

What a dedicated host's driver (port/web/src/web_online_ui.c) needs of the
game that only game code can reach: how many players its network game has,
starting the game, ending it, and bringing the lobby back after a game
without anyone pressing a button.

The browser adapter is platform code that must not include the game's
headers, so it calls these through plain prototypes.
*/

#include "cseries.h"
#include "interface/ui_widget.h"
#include "game/game_engine.h"
#include "game/players.h"
#include "networking/network_game_globals.h"
#include "networking/network_game_manager.h"
#include "networking/network_server_manager.h"
#include "objects/objects.h"
#include "units/units.h"
#include "camera/observer.h"
#include "camera/director.h"
#ifdef HALO_WEB
#include "main/main.h"
#include "game/game.h"
#include "physics/collisions.h"
#endif

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* the platform layer's */
void platform_log(char const *format, ...);

/* The network game, as network_game_globals.c lays it out for the port's
session limits (port/linux/include/halo_port_limits.h). Only the fields
read here are named. */
struct lobby_network_game
{
	byte __unknown0[HALO_PORT_NETWORK_GAME_PLAYER_COUNT_OFFSET];
	short player_count;
	struct network_player players[HALO_PORT_MAXIMUM_NETWORK_PLAYERS];
};

typedef char lobby_network_game_players_offset_assert[
	offsetof(struct lobby_network_game, players) == HALO_PORT_NETWORK_GAME_PLAYERS_OFFSET ? 1 : -1];

/* the players in the network game (the lobby's, or the game's), the host's
own among them */
long network_lobby_player_count(
	void)
{
	struct lobby_network_game *game = (struct lobby_network_game *)network_game_get_game();
	long count = 0;
	long index;

	if (!game)
		return 0;
	for (index = 0; index < HALO_PORT_MAXIMUM_NETWORK_PLAYERS; index++)
	{
		if (network_player_is_valid(&game->players[index]))
			count++;
	}
	return count;
}

/* asks the server to start the game now, as the host pressing Start does
(the server still needs its conditions: a player on every machine, both
teams in a team game) */
void network_lobby_start_now(
	void)
{
	network_game_client_request_immediate_start();
}

/* ends the game in progress, to the postgame carnage report, as the host
does when a client falls out of sync */
void network_lobby_end_game(
	void)
{
	game_engine_switch_to_postgame();
}

/* from the postgame report back to the lobby, as the host pressing A there
does; the clients follow the server's message */
boolean network_lobby_return_to_pregame(
	void)
{
	struct network_game_server *server = global_network_game_server_get();

	if (!server)
		return FALSE;
	return network_game_server_reset_to_pregame(server);
}

/* the lobby's screen and countdown, once back in the pregame: the stock
path shows the host a map-select screen with the countdown paused
(network_game_reset_to_pregame_ui), which a dedicated host has nobody to
dismiss */
boolean network_lobby_restore_pregame_screen(
	void)
{
	struct network_game_server *server = global_network_game_server_get();

	if (!server)
		return FALSE;
	ui_widgets_close_all();
	if (!ui_widget_load_by_name_or_tag(
		"ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen",
		NONE, NULL, NONE, NONE, NONE, NONE))
	{
		platform_log("network lobby: failed to load the pregame screen");
		return FALSE;
	}
	network_game_server_pause_countdown(server, FALSE);
	return TRUE;
}

/* ---------- kills, for the browser's reward popup

When this machine's player kills another, the page shows a reward over the
body. The game records where the body was and, every frame, where that
point falls on the screen (web_online_ui.c publishes it to the page). */

/* world units above a body's origin where the popup sits: about its head */
#define KILL_POPUP_HEIGHT 0.45f
/* how long a popup follows its body, in ticks (the page fades it) */
#define KILL_POPUP_TICKS (2 * TICKS_PER_SECOND)

static struct
{
	real_point3d point;
	long sequence;
	long time;
} lobby_kill;

/* this machine's player's deaths, for the death cam's penalty */
static long lobby_death_sequence;

/* every kill in the match, for a dedicated host to report to the room
service, which moves the wager between the players' wallets: the players'
names, as 12-byte ASCII strings, in a ring the page reads */
#define HOST_KILL_RING 32
#define HOST_KILL_NAME 12
static char lobby_host_kills[HOST_KILL_RING][2][HOST_KILL_NAME];
static long lobby_host_kill_sequence;

long network_lobby_host_kill_sequence(
	void)
{
	return lobby_host_kill_sequence;
}

void const *network_lobby_host_kills(
	void)
{
	return lobby_host_kills;
}

static void lobby_name(
	char *out,
	struct player_datum const *player)
{
	short index;

	for (index = 0; index < HOST_KILL_NAME - 1; index++)
	{
		wchar_t character = player->name[index];

		out[index] = character > 0 && character < 0x80 ? (char)character : 0;
		if (!out[index])
			break;
	}
	for (; index < HOST_KILL_NAME; index++)
		out[index] = 0;
}

long network_lobby_death_sequence(
	void)
{
	return lobby_death_sequence;
}

void network_lobby_note_kill(
	long killing_player_index,
	long dead_player_index,
	boolean friendly_fire)
{
	struct player_datum *killer;
	struct player_datum *dead;
	long unit_index;

	if (dead_player_index == NONE)
		return;
	dead = player_try_and_get(dead_player_index);
	if (!dead)
		return;
	/* any death of this machine's player: killed, fallen or by their own hand */
	if (dead->local_player_index != NONE)
		lobby_death_sequence++;
	if (friendly_fire || killing_player_index == NONE || killing_player_index == dead_player_index)
		return;
	killer = player_try_and_get(killing_player_index);
	if (killer && global_network_game_server_get())
	{
		long slot = lobby_host_kill_sequence % HOST_KILL_RING;

		lobby_name(lobby_host_kills[slot][0], killer);
		lobby_name(lobby_host_kills[slot][1], dead);
		lobby_host_kill_sequence++;
	}
	if (!killer || killer->local_player_index == NONE)
		return;
	unit_index = dead->unit_index != NONE ? dead->unit_index : dead->dead_unit_index;
	if (unit_index == NONE || !object_try_and_get(unit_index))
		return;
	lobby_kill.point = object_get(unit_index)->object.position;
	lobby_kill.point.z += KILL_POPUP_HEIGHT;
	lobby_kill.time = game_time_get();
	lobby_kill.sequence++;
}

/* The latest kill's point on the screen, as fractions of the picture
(0,0 top left), for the page: the sequence names the kill (0 for none);
on_screen is false behind the camera or past the edges, or once the popup
is over. */
void network_lobby_kill_on_screen(
	long *sequence,
	real *x,
	real *y,
	boolean *on_screen)
{
	struct observer_result const *camera;
	real_vector3d delta;
	real_vector3d right;
	real depth;
	real tangent_vertical;
	real aspect;
	real ndc_x;
	real ndc_y;

	*sequence = lobby_kill.sequence;
	*x = 0.5f;
	*y = 0.4f;
	*on_screen = FALSE;
	if (!lobby_kill.sequence || !game_in_progress() ||
		game_time_get() - lobby_kill.time > KILL_POPUP_TICKS)
	{
		return;
	}
	camera = observer_get_camera(0);
	if (!camera)
		return;
	delta.i = lobby_kill.point.x - camera->position.x;
	delta.j = lobby_kill.point.y - camera->position.y;
	delta.k = lobby_kill.point.z - camera->position.z;
	depth = delta.i * camera->forward.i + delta.j * camera->forward.j + delta.k * camera->forward.k;
	if (depth < 0.05f)
		return;
	/* right = forward x up (x forward, y left, z up) */
	right.i = camera->forward.j * camera->up.k - camera->forward.k * camera->up.j;
	right.j = camera->forward.k * camera->up.i - camera->forward.i * camera->up.k;
	right.k = camera->forward.i * camera->up.j - camera->forward.j * camera->up.i;
	/* the vertical field of view as main.c derives it */
	tangent_vertical = 0.75f * tanf(camera->field_of_view * 0.5f) * 0.85f;
	aspect = (real)halo_screen_width() / 480.0f;
	ndc_x = (delta.i * right.i + delta.j * right.j + delta.k * right.k) / depth / (tangent_vertical * aspect);
	ndc_y = (delta.i * camera->up.i + delta.j * camera->up.j + delta.k * camera->up.k) / depth / tangent_vertical;
	*x = 0.5f + 0.5f * ndc_x;
	*y = 0.5f - 0.5f * ndc_y;
	*on_screen = *x > 0.02f && *x < 0.98f && *y > 0.02f && *y < 0.98f;
}

/* ---------- a finished match's result, for the gateway (a dedicated host)

When its match ends, the dedicated server reports who played for which team,
their scores, who quit, and the team scores Halo itself compares for the
winner (game_engine_get_team_score), so the game's service can pay a wagered
team match by Halo's own result. Captured on the game thread at the start of
postgame; port/server/src/server_link.c sends it as its 'E' message.

The layout, little-endian: teams:u8 team0:i32 team1:i32 count:u8, then count
rows of name:12 team:i8 score:i32 quit:u8. */

#define RESULT_MAXIMUM_PLAYERS 16
#define RESULT_ROW_SIZE (HOST_KILL_NAME + 1 + 4 + 1)
#define RESULT_SIZE (1 + 4 + 4 + 1 + RESULT_MAXIMUM_PLAYERS * RESULT_ROW_SIZE)

static unsigned char lobby_result[RESULT_SIZE];
static long lobby_result_sequence;

static void result_put_long(unsigned char *out, long value)
{
	unsigned long bits = (unsigned long)value;

	out[0] = (unsigned char)bits;
	out[1] = (unsigned char)(bits >> 8);
	out[2] = (unsigned char)(bits >> 16);
	out[3] = (unsigned char)(bits >> 24);
}

void network_lobby_capture_result(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;
	unsigned char *row = lobby_result + 10;
	long count = 0;
	boolean teams = game_engine && game_engine_get_variant()->universal_variant.teams;

	memset(lobby_result, 0, sizeof(lobby_result));
	lobby_result[0] = teams ? 1 : 0;
	result_put_long(lobby_result + 1, teams ? game_engine_get_team_score(0) : 0);
	result_put_long(lobby_result + 5, teams ? game_engine_get_team_score(1) : 0);
	if (game_engine)
	{
		data_iterator_new(&iterator, player_data);
		player = (struct player_datum *)data_iterator_next(&iterator);
		while (player && count < RESULT_MAXIMUM_PLAYERS)
		{
			lobby_name((char *)row, player);
			row[HOST_KILL_NAME] = (unsigned char)(signed char)player->team_index;
			result_put_long(row + HOST_KILL_NAME + 1,
				game_engine->get_player_score(iterator.datum_index, _get_score_individual));
			row[HOST_KILL_NAME + 5] = player->quit_out_of_game ? 1 : 0;
			row += RESULT_ROW_SIZE;
			count++;
			player = (struct player_datum *)data_iterator_next(&iterator);
		}
	}
	lobby_result[9] = (unsigned char)count;
	lobby_result_sequence++;
	platform_log("network lobby: match result captured, %ld players, teams %d", count, teams ? 1 : 0);
}

long network_lobby_result_sequence(
	void)
{
	return lobby_result_sequence;
}

void const *network_lobby_result(
	long *size)
{
	*size = 10 + lobby_result[9] * RESULT_ROW_SIZE;
	return lobby_result;
}

#ifdef HALO_WEB
/* ---------- map previews (the landing's backdrops)

The camera rises above and behind where local player 0 stands and looks out
over the map, tilted down, turned by yaw; the HUD goes. A tool for capturing
the landing's map pictures (port/web/online_client.js). */

boolean scripted_show_hud(boolean show);
boolean scripted_show_hud_help_text(boolean show);

static boolean lobby_preview_active;

/* in a map preview: the game's own text (the score hint) stays off too */
boolean network_lobby_preview_active(
	void)
{
	return lobby_preview_active;
}

void network_lobby_preview(
	float up,
	float back,
	float pitch,
	float yaw)
{
	struct observer_result const *camera = observer_get_camera(0);
	real_point3d position;
	real_vector3d forward;
	real heading;
	real length;

	if (!camera)
		return;
	heading = (real)atan2(camera->forward.j, camera->forward.i) + yaw;
	forward.i = (real)cos(heading);
	forward.j = (real)sin(heading);
	forward.k = 0.0f;
	position.x = camera->position.x - forward.i * back;
	position.y = camera->position.y - forward.j * back;
	position.z = camera->position.z + up;
	forward.k = -(real)tan(pitch);
	length = (real)sqrt(forward.i * forward.i + forward.j * forward.j + forward.k * forward.k);
	forward.i /= length;
	forward.j /= length;
	forward.k /= length;
	director_preview_camera(&position, &forward);
	scripted_show_hud(FALSE);
	scripted_show_hud_help_text(FALSE);
	lobby_preview_active = TRUE;
}
#endif

#ifdef HALO_WEB
/* ---------- the landing's live backdrop

While the page shows its landing, the game plays a multiplayer map offline,
the way the map_name script command loads one (main_set_map_name: no
network, one local player, held still), and a camera at a spawn point turns
slowly over it with no HUD. Joining a game first goes back to the main menu
(network_lobby_background_stop), where the join is set up as always. */

/* the multiplayer maps, in the page's order (player_ui.c's table) */
static char const *const background_maps[] =
{
	"levels\\test\\beavercreek\\beavercreek",
	"levels\\test\\sidewinder\\sidewinder",
	"levels\\test\\damnation\\damnation",
	"levels\\test\\ratrace\\ratrace",
	"levels\\test\\prisoner\\prisoner",
	"levels\\test\\hangemhigh\\hangemhigh",
	"levels\\test\\chillout\\chillout",
	"levels\\test\\carousel\\carousel",
	"levels\\test\\boardingaction\\boardingaction",
	"levels\\test\\bloodgulch\\bloodgulch",
	"levels\\test\\wizard\\wizard",
	"levels\\test\\putput\\putput",
	"levels\\test\\longest\\longest",
};

/* the camera sweeps this far either side of the most open view, a sweep
taking this long */
#define BACKGROUND_SWEEP_RADIANS 0.7f
#define BACKGROUND_SWEEP_SECONDS 26.0f
/* how far it looks for the most open view, in world units */
#define BACKGROUND_PROBE_DISTANCE 60.0f
/* the camera waits this long after the map is up (the player spawns) */
#define BACKGROUND_SETTLE_SECONDS 0.6f

static struct
{
	boolean active;
	boolean anchored;
	float settle;
	real_point3d position;
	real heading;
	real seconds;
} lobby_background;

/* how far the camera can see from its point in a heading (to the first
wall), level and a little down */
static real background_open_distance(
	real_point3d const *position,
	real heading)
{
	struct collision_result collision;
	real_vector3d vector;
	unsigned long flags = FLAG(_collision_test_structure_bit) | FLAG(_collision_test_front_facing_surfaces_bit);

	vector.i = (real)cos(heading) * BACKGROUND_PROBE_DISTANCE;
	vector.j = (real)sin(heading) * BACKGROUND_PROBE_DISTANCE;
	vector.k = -0.06f * BACKGROUND_PROBE_DISTANCE;
	if (collision_test_vector(flags, position, &vector, NONE, &collision))
		return collision.t * BACKGROUND_PROBE_DISTANCE;
	return BACKGROUND_PROBE_DISTANCE;
}

/* 0: none, 1: loading, 2: showing */
long network_lobby_background_state(
	void)
{
	if (!lobby_background.active)
		return 0;
	return lobby_background.anchored ? 2 : 1;
}

boolean network_lobby_background_active(
	void)
{
	return lobby_background.active;
}

boolean network_lobby_background_start(
	long map_index)
{
	struct game_variant variant;

	if (map_index < 0 || map_index >= (long)NUMBEROF(background_maps) ||
		!main_menu_is_active() || global_network_game_client_get() || global_network_game_server_get())
	{
		return FALSE;
	}
	game_engine_get_variant_by_name(&variant, "slayer");
	game_set_game_variant(&variant);
	player_spawn_count = 1;
	main_set_multiplayer_map_name(background_maps[map_index]);
	main_set_map_name(background_maps[map_index]);
	main_disallow_persistent_storage();
	csmemset(&lobby_background, 0, sizeof(lobby_background));
	lobby_background.active = TRUE;
	platform_log("network lobby: backdrop %s", background_maps[map_index]);
	return TRUE;
}

/* each frame: once the map is up, the camera turns over it from a spawn */
void network_lobby_background_update(
	float seconds)
{
	real_vector3d forward;

	if (!lobby_background.active || main_menu_is_active() || !game_engine_running())
		return;
	player_input_enable(FALSE);
	if (!lobby_background.anchored)
	{
		struct observer_result const *camera;

		lobby_background.settle += seconds;
		camera = observer_get_camera(0);
		if (lobby_background.settle < BACKGROUND_SETTLE_SECONDS || !camera)
			return;
		/* above the spawned Spartan's eyes, so its own body stays out of view */
		lobby_background.position = camera->position;
		lobby_background.position.z += 0.45f;
		/* toward the most open view: the heading whose sweep sees farthest */
		{
			real best = -1.0f;
			long step;

			for (step = 0; step < 24; step++)
			{
				real heading = (real)step * (real)(2.0 * 3.14159265358979 / 24.0);
				real open = background_open_distance(&lobby_background.position, heading) +
					0.5f * background_open_distance(&lobby_background.position, heading - BACKGROUND_SWEEP_RADIANS) +
					0.5f * background_open_distance(&lobby_background.position, heading + BACKGROUND_SWEEP_RADIANS);

				if (open > best)
				{
					best = open;
					lobby_background.heading = heading;
				}
			}
		}
		lobby_background.anchored = TRUE;
	}
	lobby_background.seconds += seconds;
	{
		real sweep = BACKGROUND_SWEEP_RADIANS *
			(real)sin(lobby_background.seconds * (real)(2.0 * 3.14159265358979 / BACKGROUND_SWEEP_SECONDS));

		forward.i = (real)cos(lobby_background.heading + sweep);
		forward.j = (real)sin(lobby_background.heading + sweep);
	}
	forward.k = -0.06f;
	director_preview_camera(&lobby_background.position, &forward);
	scripted_show_hud(FALSE);
	scripted_show_hud_help_text(FALSE);
	lobby_preview_active = TRUE;
}

void network_lobby_background_stop(
	void)
{
	if (!lobby_background.active)
		return;
	csmemset(&lobby_background, 0, sizeof(lobby_background));
	lobby_preview_active = FALSE;
	player_input_enable(TRUE);
	scripted_show_hud(TRUE);
	scripted_show_hud_help_text(TRUE);
	main_goto_main_menu();
	platform_log("network lobby: backdrop over, back to the menu");
}
#endif

#ifdef HALO_WEB
/* ---------- diagnosing a player who never spawns ("Waiting for space to
clear"): once local player 0 has had no unit in a network game for longer
than any respawn, and every ten seconds after, the players this machine
holds, and which is its own */
void network_lobby_debug_spawn(
	float seconds)
{
	static float since;
	struct data_iterator iterator;
	struct player_datum *player;
	long local = local_player_get_player_index(0);

	if (!global_network_game_client_get() || !game_engine_running() || local == NONE ||
		player_get(local)->unit_index != NONE)
	{
		since = 0.0f;
		return;
	}
	since += seconds;
	if (since < 15.0f)
		return;
	since = 5.0f;
	platform_log("spawn debug: local player %lx", local);
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		char name[12];

		lobby_name(name, player);
		platform_log("spawn debug:   %lx %s machine %d controller %d local %d unit %lx quit %d deaths %d respawn %ld",
			iterator.datum_index, name, player->network_player_data.machine_index,
			player->network_player_data.controller_index, player->local_player_index,
			player->unit_index, player->quit_out_of_game, player->statistics.deaths, player->respawn_timer);
	}
}
#endif

#ifdef HALO_WEB
/* ---------- the scoreboard (the browser draws it, Halo 3's way)

While Back (Tab, F1) is held, and at the end of a match, the game marks the
scoreboard shown (game_engine.c) instead of drawing its own; the page asks
for the scores (platform_web_scoreboard) and draws them over the game. */

static real scoreboard_alpha;
static boolean scoreboard_over;
static unsigned long scoreboard_at;

void network_lobby_scoreboard_shown(
	real alpha,
	boolean over)
{
	scoreboard_alpha = alpha;
	scoreboard_over = over;
	scoreboard_at = system_milliseconds();
}

/* JSON: {"a":alpha,"over":0|1,"teams":0|1,"title":"","red":n,"blue":n,
"self":"name","players":[["name",team,score,kills,deaths,quit],...]} */
static long scoreboard_put(char *out, long size, long at, char const *text)
{
	while (*text && at < size - 1)
		out[at++] = *text++;
	out[at] = 0;
	return at;
}

static long scoreboard_put_string(char *out, long size, long at, char const *text)
{
	at = scoreboard_put(out, size, at, "\"");
	for (; *text && at < size - 3; text++)
	{
		char c = *text;

		if (c == '"' || c == '\\')
			out[at++] = '\\';
		out[at++] = (c >= 32 && c < 127) ? c : '?';
	}
	out[at] = 0;
	return scoreboard_put(out, size, at, "\"");
}

long network_lobby_scoreboard_json(
	char *out,
	long size)
{
	char number[64];
	char name[HOST_KILL_NAME + 1];
	char title[16];
	struct data_iterator iterator;
	struct player_datum *player;
	struct game_variant const *variant;
	boolean teams;
	long local;
	long at = 0;
	long first = TRUE;
	long index;

	out[0] = 0;
	if (!game_engine || system_milliseconds() - scoreboard_at > 250)
		return scoreboard_put(out, size, 0, "{\"a\":0}");
	variant = game_engine_get_variant();
	teams = variant->universal_variant.teams;
	for (index = 0; index < 11 && variant->human_readable_game_description[index]; index++)
	{
		wchar_t c = variant->human_readable_game_description[index];

		title[index] = (c >= 32 && c < 127) ? (char)c : ' ';
	}
	title[index] = 0;
	local = local_player_get_player_index(0);
	name[0] = 0;
	if (local != NONE)
		lobby_name(name, player_get(local));
	sprintf(number, "{\"a\":%.3f,\"over\":%d,\"teams\":%d,\"red\":%ld,\"blue\":%ld,\"title\":",
		(double)scoreboard_alpha, scoreboard_over ? 1 : 0, teams ? 1 : 0,
		teams ? (long)game_engine_get_team_score(0) : 0L, teams ? (long)game_engine_get_team_score(1) : 0L);
	at = scoreboard_put(out, size, at, number);
	at = scoreboard_put_string(out, size, at, title);
	at = scoreboard_put(out, size, at, ",\"self\":");
	at = scoreboard_put_string(out, size, at, name);
	at = scoreboard_put(out, size, at, ",\"players\":[");
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL && at < size - 160)
	{
		long kills = 0;
		short kind;

		for (kind = 0; kind < 4; kind++)
			kills += player->statistics.kills[kind];
		lobby_name(name, player);
		at = scoreboard_put(out, size, at, first ? "[" : ",[");
		first = FALSE;
		at = scoreboard_put_string(out, size, at, name);
		sprintf(number, ",%d,%ld,%ld,%d,%d]", (int)player->team_index,
			(long)game_engine->get_player_score(iterator.datum_index, _get_score_individual),
			kills, (int)player->statistics.deaths, player->quit_out_of_game ? 1 : 0);
		at = scoreboard_put(out, size, at, number);
	}
	return scoreboard_put(out, size, at, "]}");
}
#endif

#ifdef HALO_WEB
/* ---------- watching (a spectator)

A spectator's machine has no player in the game (the server refuses it one:
port/server/src/server_link.c). The camera follows a player from behind and
above, along their aim, kept out of walls; the page asks for the next one
(a click) and shows whose view it is. The director and observer run local
player 0's camera without a player (camera/director.c, camera/observer.c,
main/main.c: network_lobby_spectating). */

#define SPECTATE_BACK 2.4f
#define SPECTATE_UP 0.55f
#define SPECTATE_EYE 0.62f

static struct
{
	boolean on;
	long target;
	boolean placed;
	boolean hold_scores;
	real_point3d position;
	/* the one followed after the last two ticks: the camera blends them by
	how far into the next tick the frame is, as the renderer blends the body
	it draws (render_interpolation.c) */
	long tick;
	long tick_target;
	real_point3d eye[2];
	real_vector3d aim[2];
	real heading;
} lobby_spectator;

boolean network_lobby_spectating(
	void)
{
	return lobby_spectator.on;
}

void network_lobby_spectate(
	boolean on)
{
	csmemset(&lobby_spectator, 0, sizeof(lobby_spectator));
	lobby_spectator.on = on;
	lobby_spectator.target = NONE;
	lobby_preview_active = on;
	platform_log("network lobby: %s", on ? "watching, not playing" : "playing");
}

void network_lobby_spectate_hold_scores(
	boolean hold)
{
	lobby_spectator.hold_scores = hold;
}

/* a player alive in the game, with a body to follow */
static boolean spectate_followable(
	long player_index)
{
	struct player_datum *player = player_index != NONE ? player_try_and_get(player_index) : NULL;

	return player && !player->quit_out_of_game && player->unit_index != NONE &&
		object_try_and_get(player->unit_index) &&
		!TEST_FLAG(object_get(player->unit_index)->object.damage_flags, _object_dead_bit);
}

/* the next player to follow after the current one (any, when none) */
void network_lobby_spectate_next(
	void)
{
	struct data_iterator iterator;
	struct player_datum *player;
	long first = NONE;
	boolean passed = lobby_spectator.target == NONE;

	if (!lobby_spectator.on || !game_engine_running())
		return;
	data_iterator_new(&iterator, player_data);
	while ((player = (struct player_datum *)data_iterator_next(&iterator)) != NULL)
	{
		if (!spectate_followable(iterator.datum_index))
			continue;
		if (first == NONE)
			first = iterator.datum_index;
		if (passed)
		{
			lobby_spectator.target = iterator.datum_index;
			lobby_spectator.placed = FALSE;
			return;
		}
		if (iterator.datum_index == lobby_spectator.target)
			passed = TRUE;
	}
	if (first != NONE && first != lobby_spectator.target)
		lobby_spectator.placed = FALSE;
	lobby_spectator.target = first;
}

/* whose view it is, for the page ("" for nobody yet) */
void network_lobby_spectate_target_name(
	char *out)
{
	out[0] = 0;
	if (lobby_spectator.on && lobby_spectator.target != NONE && player_try_and_get(lobby_spectator.target))
		lobby_name(out, player_get(lobby_spectator.target));
}

void network_lobby_spectate_update(
	float seconds)
{
	struct object_datum *object;
	struct unit_datum *unit;
	real_point3d eye;
	real_point3d desired;
	real_vector3d aim;
	real_vector3d flat;
	real_vector3d back;
	real_vector3d forward;
	real length;

	if (!lobby_spectator.on || !game_engine_running())
		return;
	if (lobby_spectator.hold_scores)
		network_lobby_scoreboard_shown(1.0f, FALSE);
	scripted_show_hud(FALSE);
	scripted_show_hud_help_text(FALSE);
	/* (never player_input_enable(FALSE), as the backdrop does: it holds every
	player's controls still on this machine, and the players followed would
	only slide where the host corrects them, never aim, turn or fire) */
	player_input_enable(TRUE);
	lobby_preview_active = TRUE;
	/* the one followed died or left: hold the view a moment, then the next */
	if (!spectate_followable(lobby_spectator.target))
	{
		network_lobby_spectate_next();
		if (lobby_spectator.target == NONE)
			return;
	}
	unit = unit_get(player_get(lobby_spectator.target)->unit_index);
	object = (struct object_datum *)unit;
	eye = object->object.position;
	/* riding: the vehicle's place */
	if (object->object.parent_object_index != NONE && object_try_and_get(object->object.parent_object_index))
		eye = object_get(object->object.parent_object_index)->object.position;
	eye.z += SPECTATE_EYE;
	aim = unit->unit.aiming_vector;
	length = (real)sqrt(aim.i * aim.i + aim.j * aim.j + aim.k * aim.k);
	/* (no aim yet, before they have moved: the way their body faces) */
	if (length < 0.001f)
	{
		aim = object->object.forward;
		length = (real)sqrt(aim.i * aim.i + aim.j * aim.j + aim.k * aim.k);
	}
	if (length < 0.001f)
	{
		aim.i = 1.0f;
		aim.j = 0.0f;
		aim.k = 0.0f;
	}
	else
	{
		aim.i /= length;
		aim.j /= length;
		aim.k /= length;
	}
	/* where they were after each of the last two ticks, blended to this
	frame: the camera moves and turns with the body as it is drawn */
	{
		long tick = game_time_get();
		real t = game_time_get_tick_fraction();

		if (lobby_spectator.tick_target != lobby_spectator.target)
		{
			lobby_spectator.eye[0] = lobby_spectator.eye[1] = eye;
			lobby_spectator.aim[0] = lobby_spectator.aim[1] = aim;
			lobby_spectator.tick_target = lobby_spectator.target;
			lobby_spectator.tick = tick;
		}
		else if (tick != lobby_spectator.tick)
		{
			lobby_spectator.eye[0] = lobby_spectator.eye[1];
			lobby_spectator.aim[0] = lobby_spectator.aim[1];
			lobby_spectator.eye[1] = eye;
			lobby_spectator.aim[1] = aim;
			lobby_spectator.tick = tick;
		}
		if (t < 0.0f)
			t = 0.0f;
		if (t > 1.0f)
			t = 1.0f;
		eye.x = lobby_spectator.eye[0].x + (lobby_spectator.eye[1].x - lobby_spectator.eye[0].x) * t;
		eye.y = lobby_spectator.eye[0].y + (lobby_spectator.eye[1].y - lobby_spectator.eye[0].y) * t;
		eye.z = lobby_spectator.eye[0].z + (lobby_spectator.eye[1].z - lobby_spectator.eye[0].z) * t;
		aim.i = lobby_spectator.aim[0].i + (lobby_spectator.aim[1].i - lobby_spectator.aim[0].i) * t;
		aim.j = lobby_spectator.aim[0].j + (lobby_spectator.aim[1].j - lobby_spectator.aim[0].j) * t;
		aim.k = lobby_spectator.aim[0].k + (lobby_spectator.aim[1].k - lobby_spectator.aim[0].k) * t;
		length = (real)sqrt(aim.i * aim.i + aim.j * aim.j + aim.k * aim.k);
		if (length > 0.001f)
		{
			aim.i /= length;
			aim.j /= length;
			aim.k /= length;
		}
	}
	flat.i = aim.i;
	flat.j = aim.j;
	flat.k = 0.0f;
	length = (real)sqrt(flat.i * flat.i + flat.j * flat.j);
	if (length < 0.001f)
	{
		flat.i = 1.0f;
		flat.j = 0.0f;
	}
	else
	{
		flat.i /= length;
		flat.j /= length;
	}
	/* behind and above, short of any wall */
	back.i = -flat.i * SPECTATE_BACK;
	back.j = -flat.j * SPECTATE_BACK;
	back.k = SPECTATE_UP;
	{
		struct collision_result collision;
		unsigned long flags = FLAG(_collision_test_structure_bit) | FLAG(_collision_test_front_facing_surfaces_bit);
		real reach = 1.0f;

		if (collision_test_vector(flags, &eye, &back, NONE, &collision))
			reach = collision.t > 0.15f ? collision.t - 0.1f : 0.05f;
		/* a wall right behind them: up over their head instead, rather
		than inside their shoulders */
		if (reach < 0.45f)
		{
			real_vector3d over;
			real over_reach = 1.0f;

			over.i = -flat.i * SPECTATE_BACK * 0.35f;
			over.j = -flat.j * SPECTATE_BACK * 0.35f;
			over.k = 1.25f;
			if (collision_test_vector(flags, &eye, &over, NONE, &collision))
				over_reach = collision.t > 0.15f ? collision.t - 0.1f : 0.05f;
			if (over_reach * 1.3f > reach)
			{
				back = over;
				reach = over_reach;
			}
		}
		desired.x = eye.x + back.i * reach;
		desired.y = eye.y + back.j * reach;
		desired.z = eye.z + back.k * reach;
	}
	if (!lobby_spectator.placed)
	{
		lobby_spectator.position = desired;
		lobby_spectator.placed = TRUE;
	}
	else
	{
		real follow = seconds * 30.0f;

		if (follow > 1.0f)
			follow = 1.0f;
		lobby_spectator.position.x += (desired.x - lobby_spectator.position.x) * follow;
		lobby_spectator.position.y += (desired.y - lobby_spectator.position.y) * follow;
		lobby_spectator.position.z += (desired.z - lobby_spectator.position.z) * follow;
	}
	/* looking where they look */
	forward.i = eye.x + aim.i * 8.0f - lobby_spectator.position.x;
	forward.j = eye.y + aim.j * 8.0f - lobby_spectator.position.y;
	forward.k = eye.z + aim.k * 8.0f - lobby_spectator.position.z;
	length = (real)sqrt(forward.i * forward.i + forward.j * forward.j + forward.k * forward.k);
	if (length > 0.001f)
	{
		forward.i /= length;
		forward.j /= length;
		forward.k /= length;
	}
	lobby_spectator.heading = (real)atan2(forward.j, forward.i);
	director_preview_camera(&lobby_spectator.position, &forward);
}

float network_lobby_player_heading(
	long absolute_index)
{
	struct player_datum *player;
	struct unit_datum *unit;

	if (!player_data || absolute_index < 0 || absolute_index >= player_data->maximum_count)
		return 99.0f;
	player = (struct player_datum *)((byte *)player_data->data + absolute_index * player_data->size);
	if (!player->identifier || player->unit_index == NONE || !object_try_and_get(player->unit_index))
		return 99.0f;
	unit = unit_get(player->unit_index);
	return (real)atan2(unit->unit.aiming_vector.j, unit->unit.aiming_vector.i);
}

float network_lobby_spectate_heading(
	void)
{
	return lobby_spectator.heading;
}
#endif

#ifdef HALO_WEB
/* ---------- a broadcast's playback

A match on the CDN, a few seconds behind (services/signaling/src/
broadcast.ts): the page fetches its chunks of two seconds and hands them
here (platform_web_broadcast_feed). Each chunk holds what the server sent
every machine in that time, opened by what a machine joining then would be
sent: the game (its settings and start) and the world (every object, the
scores, the game's state). The client plays them as though they came from
the server, with no connection (network_client_manager.c's playback):

  the first chunk's game: the client loads the map
  then the newest chunk's world, and on from there in real time: each
  message at the tick it was sent, chunk after chunk; the openings of
  later chunks are skipped, unless the viewer has fallen too far behind,
  when it jumps to the newest chunk's world and plays on from there.

Watching (network_lobby_spectate) follows a player as for a spectator. */

boolean network_game_client_begin_playback(void);
void network_game_client_end_playback(void);
boolean network_game_client_play_message(word *message, short size);

#define BROADCAST_QUEUE 6
/* chunks waiting before the viewer jumps ahead to the newest */
#define BROADCAST_BEHIND 3
#define BROADCAST_HEADER 20
#define BROADCAST_ENTRY 6

enum
{
	_playback_idle = 0,
	_playback_waiting,
	_playback_loading,
	_playback_playing,
};

struct broadcast_chunk
{
	byte *data;
	long size;
	unsigned long sequence;
	long start_tick;
	long end_tick;
	long count;
	/* the next entry to play: its byte offset and index */
	long cursor;
	long played;
};

static struct
{
	long phase;
	struct broadcast_chunk queue[BROADCAST_QUEUE];
	long length;
	/* the tick being played, in the recording's time */
	real clock;
	unsigned long last_sequence;
	long messages;
	long failures;
} lobby_broadcast;

static unsigned long broadcast_u32(byte const *at)
{
	return (unsigned long)at[0] | ((unsigned long)at[1] << 8) | ((unsigned long)at[2] << 16) | ((unsigned long)at[3] << 24);
}

static void broadcast_drop_front(
	void)
{
	if (lobby_broadcast.length == 0)
		return;
	free(lobby_broadcast.queue[0].data);
	memmove(&lobby_broadcast.queue[0], &lobby_broadcast.queue[1],
		(lobby_broadcast.length - 1) * sizeof(lobby_broadcast.queue[0]));
	lobby_broadcast.length--;
}

static void broadcast_clear(
	void)
{
	while (lobby_broadcast.length > 0)
		broadcast_drop_front();
}

/* plays a chunk's entries of one section (or the stream, up to a tick):
returns whether it reached the chunk's end */
static boolean broadcast_play(
	struct broadcast_chunk *chunk,
	long section,
	real until_tick)
{
	while (chunk->played < chunk->count && chunk->cursor + BROADCAST_ENTRY <= chunk->size)
	{
		byte *entry = chunk->data + chunk->cursor;
		long offset = (long)entry[0] | ((long)entry[1] << 8);
		long entry_section = entry[3];
		long size = (long)entry[4] | ((long)entry[5] << 8);

		if (chunk->cursor + BROADCAST_ENTRY + size > chunk->size)
			break;
		if (entry_section == 0)
		{
			/* the stream: only in its time, and not while an opening plays */
			if (section != 0 || (real)(chunk->start_tick + offset) > until_tick)
				return FALSE;
		}
		else if (section != entry_section)
		{
			/* another section of the opening: skipped */
			chunk->cursor += BROADCAST_ENTRY + size;
			chunk->played++;
			continue;
		}
		if (size >= (long)sizeof(word))
		{
			/* (aligned for the handlers) */
			word message[0x1000 / sizeof(word)];

			if (size <= (long)sizeof(message))
			{
				memcpy(message, entry + BROADCAST_ENTRY, size);
				lobby_broadcast.messages++;
				if (!network_game_client_play_message(message, (short)size))
					lobby_broadcast.failures++;
			}
		}
		chunk->cursor += BROADCAST_ENTRY + size;
		chunk->played++;
	}
	return chunk->played >= chunk->count;
}

/* a chunk's opening section, from the start of the chunk */
static void broadcast_play_opening(
	struct broadcast_chunk *chunk,
	long section)
{
	chunk->cursor = BROADCAST_HEADER;
	chunk->played = 0;
	broadcast_play(chunk, section, -1.0f);
	/* the stream after it starts at the chunk's top again; the openings it
	passes are skipped */
	chunk->cursor = BROADCAST_HEADER;
	chunk->played = 0;
}

boolean network_lobby_broadcast_start(
	void)
{
	broadcast_clear();
	csmemset(&lobby_broadcast, 0, sizeof(lobby_broadcast));
	if (!network_game_client_begin_playback())
		return FALSE;
	lobby_broadcast.phase = _playback_waiting;
	network_lobby_spectate(TRUE);
	platform_log("network lobby: broadcast playback waiting for its first chunk");
	return TRUE;
}

void network_lobby_broadcast_stop(
	void)
{
	if (lobby_broadcast.phase == _playback_idle)
		return;
	broadcast_clear();
	lobby_broadcast.phase = _playback_idle;
	network_game_client_end_playback();
	network_lobby_spectate(FALSE);
	platform_log("network lobby: broadcast playback over (%ld messages, %ld refused)",
		lobby_broadcast.messages, lobby_broadcast.failures);
}

/* the page's next chunk (a copy is kept) */
boolean network_lobby_broadcast_feed(
	byte const *data,
	long size)
{
	struct broadcast_chunk *chunk;

	if (lobby_broadcast.phase == _playback_idle || size < BROADCAST_HEADER ||
		data[0] != 'H' || data[1] != 'B' || data[2] != 'C' || data[3] != '1')
	{
		return FALSE;
	}
	if (broadcast_u32(data + 4) <= lobby_broadcast.last_sequence)
		return FALSE;
	if (lobby_broadcast.length == BROADCAST_QUEUE)
		broadcast_drop_front();
	chunk = &lobby_broadcast.queue[lobby_broadcast.length];
	chunk->data = (byte *)malloc(size);
	if (!chunk->data)
		return FALSE;
	memcpy(chunk->data, data, size);
	chunk->size = size;
	chunk->sequence = broadcast_u32(data + 4);
	chunk->start_tick = (long)broadcast_u32(data + 8);
	chunk->end_tick = (long)broadcast_u32(data + 12);
	chunk->count = (long)broadcast_u32(data + 16);
	chunk->cursor = BROADCAST_HEADER;
	chunk->played = 0;
	lobby_broadcast.length++;
	lobby_broadcast.last_sequence = chunk->sequence;
	return TRUE;
}

/* 0 none, 1 waiting for a chunk, 2 loading the map, 3 playing; and how many
chunks wait */
long network_lobby_broadcast_state(
	long *queued)
{
	if (queued)
		*queued = lobby_broadcast.length;
	return lobby_broadcast.phase;
}

/* the newest chunk's world, and on from there */
static void broadcast_join_newest(
	void)
{
	struct broadcast_chunk *chunk;

	while (lobby_broadcast.length > 1)
		broadcast_drop_front();
	chunk = &lobby_broadcast.queue[0];
	broadcast_play_opening(chunk, 2);
	lobby_broadcast.clock = (real)chunk->start_tick;
}

void network_lobby_broadcast_update(
	float seconds)
{
	switch (lobby_broadcast.phase)
	{
	case _playback_waiting:
		if (lobby_broadcast.length == 0)
			return;
		/* the game: the map loads */
		broadcast_play_opening(&lobby_broadcast.queue[lobby_broadcast.length - 1], 1);
		lobby_broadcast.phase = _playback_loading;
		platform_log("network lobby: broadcast chunk %lu: loading the game", lobby_broadcast.queue[lobby_broadcast.length - 1].sequence);
		return;
	case _playback_loading:
		if (!game_engine_running() || lobby_broadcast.length == 0)
			return;
		broadcast_join_newest();
		lobby_broadcast.phase = _playback_playing;
		platform_log("network lobby: broadcast playing from chunk %lu", lobby_broadcast.queue[0].sequence);
		return;
	case _playback_playing:
		break;
	default:
		return;
	}
	if (lobby_broadcast.length == 0)
		return;
	/* fallen behind: the newest chunk's world, and on */
	if (lobby_broadcast.length > BROADCAST_BEHIND)
	{
		platform_log("network lobby: broadcast behind by %ld chunks; jumping ahead", lobby_broadcast.length - 1);
		broadcast_join_newest();
	}
	lobby_broadcast.clock += seconds * (real)TICKS_PER_SECOND;
	for (;;)
	{
		struct broadcast_chunk *chunk = &lobby_broadcast.queue[0];

		if (!broadcast_play(chunk, 0, lobby_broadcast.clock))
		{
			/* (no further than the chunk's end until the next is here) */
			if (lobby_broadcast.clock > (real)chunk->end_tick)
				lobby_broadcast.clock = (real)chunk->end_tick;
			return;
		}
		if (lobby_broadcast.length == 1)
		{
			if (lobby_broadcast.clock > (real)chunk->end_tick)
				lobby_broadcast.clock = (real)chunk->end_tick;
			return;
		}
		broadcast_drop_front();
	}
}
#endif
