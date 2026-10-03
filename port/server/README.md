# Dedicated server

`ninja server` builds `build/server/halo-server`: the native Linux game
(`port/linux`) as a dedicated server for browser players. It draws nothing,
plays no sound, and hosts with no player of its own.

It is the Linux build with three differences, all under `HALO_SERVER`:

- **The browser's sockets.** The game's sockets are the browser build's
  virtual sockets (`port/web/src/web_loopback_net.c`). Each remote machine
  is an address in 100.64.0.0/10, and its traffic travels as the browser's
  DataChannel frames. A browser player's game therefore talks to the server
  exactly as it talks to a browser host.
- **A link to the gateway.** `src/server_link.c` carries those frames, and
  the lobby driver's commands and state, over one local `SOCK_SEQPACKET`
  socket (`HALO_SERVER_LINK`) to the gateway in `services/game-server`, which
  carries them over WebRTC. The message format is at the top of
  `server_link.c`. If the gateway goes away, the server exits.
- **No host player.** The browser's lobby driver
  (`port/web/src/web_online_ui.c`) runs the lobby, but does not add a
  player. The server lets its own machine have no player
  (`server_has_a_player_on_each_machine` in
  `source/networking/network_server_manager.c`): it is the machine that
  reaches the server on the loopback. Nor does it leave the game when a
  player leaves and it has no player of its own
  (`source/networking/network_client_manager.c`), which would end the match
  for everyone.

The main loop sleeps to 60 frames a second (`server_link_frame`), since no
display paces it. The game still ticks at 30 Hz.

The server needs the same game data as the Linux build (`maps/` in the data
root). The gateway starts it; refer to `services/game-server/README.md`.
