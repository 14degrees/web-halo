/* The dedicated server's link to its gateway (server_link.c). */

#ifndef HALO_SERVER_LINK_H
#define HALO_SERVER_LINK_H

/* connects to the gateway's socket (HALO_SERVER_LINK) and starts carrying
frames and lobby commands; exits the process if the gateway is not there */
void server_link_start(void);

/* each frame: waits until the next 60th of a second (the server has no
display to pace it) */
void server_link_frame(void);

#endif
