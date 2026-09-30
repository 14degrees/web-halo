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
