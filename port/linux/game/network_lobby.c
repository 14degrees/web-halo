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
#include "camera/observer.h"

#include <math.h>

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
