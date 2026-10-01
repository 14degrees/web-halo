/* The dedicated server's link to its gateway (services/game-server).

The server is the native Linux build with the browser's virtual sockets
(port/web/src/web_loopback_net.c): every remote machine is a 100.64.0.0/10
address whose traffic travels as the browser's DataChannel frames. In a
browser, library_web_transport.js carries those frames over WebRTC. Here the
gateway does, and this file carries them between the game and the gateway
over one local SOCK_SEQPACKET socket (HALO_SERVER_LINK), one message per
packet. The same socket carries the lobby driver's commands
(port/web/src/web_online_ui.c) one way and its state and kills the other.

Messages start with a type byte; numbers are little-endian, addresses are
as the game holds them (network byte order).

gateway to game
  'P' key:u32 identifier:6       a peer: answered with 'A'
  'R' address:u32                the peer is gone
  'S' address:u32 open:u8        both of its DataChannels are open (1) or not
  'F' address:u32 reliable:u8 frame
  'H' map:u8 mode:u8 minimum:u8 countdown:u8 postgame:u8
                                 host the dedicated lobby
  'G' map:u8 mode:u8             the next game's map and mode
  'm' minimum:u8                 the players the lobby waits for from now on
  'T' address:u32 team:u8        the team this peer's players join (a
                                 matchmade team match keeps a party together)
  'X'                            end the match for players waiting to join
  'Q'                            stop the server

game to gateway
  'I' identifier:6               hello: this machine's XNADDR identifier
  'A' key:u32 address:u32        a peer's virtual address (0: none free)
  'F' address:u32 reliable:u8 frame
  'M' match:u8 countdown:i16 players:u16 client:i8 online:u8
                                 the lobby's state, on a change and each second
  'K' killer:12 victim:12        a kill on the server, by player name
  'E' result                     the match's result as it ended, sent before
                                 the postgame 'M' (port/linux/game/
                                 network_lobby.c, network_lobby_capture_result)
  'D' address:u32                the game cannot take this peer's traffic: drop it

Frames the game cannot take yet (a stream's buffer is full) wait in a
backlog of their own peer, so one peer the game has stopped reading (a
player who refreshed) never holds up the others' traffic. A backlog that
grows past its limit drops that peer.

If the gateway goes away the match cannot go on: the server exits. */

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "server_link.h"

/* port/web/src/web_loopback_net.h */
unsigned long web_net_remote_add_peer(const void *identifier, int identifier_length);
int web_net_remote_remove_peer(unsigned long address);
int web_net_remote_set_peer_state(unsigned long address, int connected,
	int reliable_writeable, int unreliable_writeable);
const void *web_net_remote_local_identifier(void);
void *web_net_remote_ingress_buffer(void);
int web_net_remote_ingress_capacity(void);
int web_net_remote_receive(unsigned long address, int length);

/* port/web/src/web_online_ui.h */
int platform_web_online_host_dedicated(int map_index, int mode_index,
	int minimum_players, int countdown_seconds, int postgame_seconds);
int platform_web_online_set_next_game(int map_index, int mode_index);
void platform_web_online_request_restart(void);
int platform_web_online_set_minimum_players(int minimum_players);
void platform_web_online_set_headless(int headless);
int platform_web_online_get_match_state(void);
int platform_web_online_get_countdown_remaining(void);
int platform_web_online_get_player_count(void);
int platform_web_online_get_client_state(void);
int platform_web_online_get_state(void);
int platform_web_host_kill_sequence(void);
void const *platform_web_host_kills(void);
/* the match's team plan, below */
static void clear_teams(void);
static void set_team(uint32_t address, int team);

/* port/linux/game/network_lobby.c */
long network_lobby_result_sequence(void);
void const *network_lobby_result(long *size);

enum
{
	LINK_IDENTIFIER_SIZE = 6,
	LINK_FRAME_LIMIT = 12 + 16 * 1024,
	LINK_PACKET_LIMIT = 1 + 4 + 1 + LINK_FRAME_LIMIT,
	LINK_CONNECT_SECONDS = 15,
	/* network_lobby.c's ring of the host's kills */
	LINK_KILL_RING = 32,
	LINK_KILL_NAME = 12,
	LINK_STATUS_MILLISECONDS = 100,
	LINK_STATUS_REPEAT_TICKS = 10,
	/* frames waiting for a peer the game is not reading */
	LINK_BACKLOG_PEERS = 128,
	LINK_BACKLOG_LIMIT = 2 << 20,
};

struct link_frame
{
	struct link_frame *next;
	int length;
	unsigned char data[];
};

/* one peer's frames the game could not take yet, oldest first */
static struct link_backlog
{
	unsigned long address;
	struct link_frame *first;
	struct link_frame *last;
	size_t bytes;
} link_backlogs[LINK_BACKLOG_PEERS];
static int link_backlog_frames;

static int link_socket = -1;
static pthread_mutex_t link_send_mutex = PTHREAD_MUTEX_INITIALIZER;

static void put_u32(unsigned char *bytes, uint32_t value)
{
	memcpy(bytes, &value, sizeof(value));
}

static uint32_t get_u32(const unsigned char *bytes)
{
	uint32_t value;

	memcpy(&value, bytes, sizeof(value));
	return value;
}

static void link_lost(const char *why)
{
	fprintf(stderr, "halo-server: the gateway link is gone (%s); stopping\n", why);
	_exit(3);
}

static void link_send(const unsigned char *packet, size_t length)
{
	ssize_t sent;

	pthread_mutex_lock(&link_send_mutex);
	do
		sent = send(link_socket, packet, length, MSG_NOSIGNAL);
	while (sent < 0 && errno == EINTR);
	pthread_mutex_unlock(&link_send_mutex);
	if (sent != (ssize_t)length)
		link_lost(sent < 0 ? strerror(errno) : "short send");
}

/* web_loopback_net.c's way out: one frame to one peer. The send blocks
while the gateway catches up, as a full socket buffer would. */
int web_transport_send(unsigned long address, int reliable, const void *buffer, int length)
{
	unsigned char packet[LINK_PACKET_LIMIT];

	if (length < 12 || length > LINK_FRAME_LIMIT)
		return 0;
	packet[0] = 'F';
	put_u32(packet + 1, (uint32_t)address);
	packet[5] = reliable ? 1 : 0;
	memcpy(packet + 6, buffer, (size_t)length);
	link_send(packet, 6 + (size_t)length);
	return 1;
}

static void pause_briefly(void)
{
	struct timespec pause = { 0, 1000000 };

	nanosleep(&pause, NULL);
}

static void add_peer(const unsigned char *packet, ssize_t length)
{
	unsigned char answer[9];
	unsigned long address = 0;
	int attempt;

	if (length != 1 + 4 + LINK_IDENTIFIER_SIZE)
		return;
	/* zero is also "the sockets are busy": a short wait, then again */
	for (attempt = 0; attempt < 2000 && !address; attempt++)
	{
		address = web_net_remote_add_peer(packet + 5, LINK_IDENTIFIER_SIZE);
		if (!address)
			pause_briefly();
	}
	answer[0] = 'A';
	memcpy(answer + 1, packet + 1, 4);
	put_u32(answer + 5, (uint32_t)address);
	link_send(answer, sizeof(answer));
}

static struct link_backlog *backlog_for(unsigned long address, int create)
{
	struct link_backlog *free_slot = NULL;
	int index;

	for (index = 0; index < LINK_BACKLOG_PEERS; index++)
	{
		if (link_backlogs[index].first && link_backlogs[index].address == address)
			return &link_backlogs[index];
		if (!link_backlogs[index].first && !free_slot)
			free_slot = &link_backlogs[index];
	}
	if (create && free_slot)
		free_slot->address = address;
	return create ? free_slot : NULL;
}

static void backlog_clear(struct link_backlog *backlog)
{
	while (backlog->first)
	{
		struct link_frame *frame = backlog->first;

		backlog->first = frame->next;
		free(frame);
		link_backlog_frames--;
	}
	backlog->last = NULL;
	backlog->bytes = 0;
}

static void drop_peer(unsigned long address, const char *why)
{
	unsigned char notice[5];
	struct link_backlog *backlog = backlog_for(address, 0);

	if (backlog)
		backlog_clear(backlog);
	fprintf(stderr, "halo-server: dropping peer %08lx: %s\n", address, why);
	notice[0] = 'D';
	put_u32(notice + 1, (uint32_t)address);
	link_send(notice, sizeof(notice));
}

/* 1: the game took the frame (or refused it for good), 0: not yet */
static int deliver(unsigned long address, const unsigned char *frame, int length)
{
	int attempt;

	memcpy(web_net_remote_ingress_buffer(), frame, (size_t)length);
	/* zero can be the socket lock, busy for a moment: try a few times */
	for (attempt = 0; attempt < 3; attempt++)
	{
		int result = web_net_remote_receive(address, length);

		if (result != 0)
			return 1;
		pause_briefly();
	}
	return 0;
}

/* each peer's waiting frames, oldest first, until one is still refused */
static void retry_backlogs(void)
{
	int index;

	for (index = 0; index < LINK_BACKLOG_PEERS; index++)
	{
		struct link_backlog *backlog = &link_backlogs[index];

		while (backlog->first)
		{
			struct link_frame *frame = backlog->first;

			if (!deliver(backlog->address, frame->data, frame->length))
				break;
			backlog->first = frame->next;
			if (!backlog->first)
				backlog->last = NULL;
			backlog->bytes -= (size_t)frame->length;
			link_backlog_frames--;
			free(frame);
		}
	}
}

static void receive_frame(const unsigned char *packet, ssize_t length)
{
	unsigned long address;
	int frame_length = (int)length - 6;
	struct link_backlog *backlog;
	struct link_frame *frame;

	if (length < 6 || frame_length < 12 || frame_length > web_net_remote_ingress_capacity())
		return;
	address = get_u32(packet + 1);
	backlog = backlog_for(address, 0);
	/* behind a waiting frame of the same peer: in order, after it */
	if (!backlog && deliver(address, packet + 6, frame_length))
		return;
	backlog = backlog ? backlog : backlog_for(address, 1);
	if (!backlog)
	{
		drop_peer(address, "no room to wait");
		return;
	}
	if (backlog->bytes + (size_t)frame_length > LINK_BACKLOG_LIMIT)
	{
		drop_peer(address, "the game stopped taking its traffic");
		return;
	}
	frame = malloc(sizeof(*frame) + (size_t)frame_length);
	if (!frame)
	{
		drop_peer(address, "out of memory");
		return;
	}
	frame->next = NULL;
	frame->length = frame_length;
	memcpy(frame->data, packet + 6, (size_t)frame_length);
	if (backlog->last)
		backlog->last->next = frame;
	else
		backlog->first = frame;
	backlog->last = frame;
	backlog->bytes += (size_t)frame_length;
	link_backlog_frames++;
}

static void *link_reader(void *unused)
{
	static unsigned char packet[LINK_PACKET_LIMIT];

	(void)unused;
	for (;;)
	{
		ssize_t length;

		/* while frames wait, look for new ones only briefly, and retry */
		if (link_backlog_frames > 0)
		{
			struct pollfd ready = { link_socket, POLLIN, 0 };

			retry_backlogs();
			if (poll(&ready, 1, 2) == 0)
				continue;
		}
		length = recv(link_socket, packet, sizeof(packet), 0);
		if (length < 0 && errno == EINTR)
			continue;
		if (length <= 0)
			link_lost(length < 0 ? strerror(errno) : "closed");
		switch (packet[0])
		{
		case 'P':
			add_peer(packet, length);
			break;
		case 'R':
			if (length == 5)
			{
				struct link_backlog *backlog = backlog_for(get_u32(packet + 1), 0);

				if (backlog)
					backlog_clear(backlog);
				while (!web_net_remote_remove_peer(get_u32(packet + 1)))
					pause_briefly();
			}
			break;
		case 'S':
			if (length == 6)
			{
				int open = packet[5] ? 1 : 0;

				while (web_net_remote_set_peer_state(get_u32(packet + 1), open, open, open) == 0)
					pause_briefly();
			}
			break;
		case 'F':
			receive_frame(packet, length);
			break;
		case 'H':
			/* a new match: no team plan until the gateway sends one */
			clear_teams();
			if (length == 6 &&
				!platform_web_online_host_dedicated(packet[1], packet[2], packet[3], packet[4], packet[5]))
			{
				fprintf(stderr, "halo-server: the lobby settings were refused\n");
			}
			break;
		case 'G':
			if (length == 3)
				platform_web_online_set_next_game(packet[1], packet[2]);
			break;
		case 'X':
			platform_web_online_request_restart();
			break;
		case 'm':
			if (length == 2)
				platform_web_online_set_minimum_players(packet[1]);
			break;
		case 'T':
			if (length == 6)
			{
				uint32_t address;

				memcpy(&address, packet + 1, 4);
				set_team(address, packet[5]);
			}
			break;
		case 'Q':
			fprintf(stderr, "halo-server: stopping at the gateway's request\n");
			_exit(0);
		default:
			break;
		}
	}
	return NULL;
}

/* ---------- the match's team plan

The matchmaker places a team match's players on teams before it forms (a
party together); the gateway sends each peer's team as it connects, and
the server's team choice (network_server_manager.c,
network_game_server_add_player_to_game) asks here first. */

#define LINK_TEAM_ENTRIES 64

static struct
{
	uint32_t address;
	int team;
} link_teams[LINK_TEAM_ENTRIES];
static int link_team_count;
static pthread_mutex_t link_team_mutex = PTHREAD_MUTEX_INITIALIZER;

static void clear_teams(void)
{
	pthread_mutex_lock(&link_team_mutex);
	link_team_count = 0;
	pthread_mutex_unlock(&link_team_mutex);
}

static void set_team(uint32_t address, int team)
{
	int index;

	pthread_mutex_lock(&link_team_mutex);
	for (index = 0; index < link_team_count; index++)
	{
		if (link_teams[index].address == address)
			break;
	}
	if (index < LINK_TEAM_ENTRIES)
	{
		link_teams[index].address = address;
		link_teams[index].team = team;
		if (index == link_team_count)
			link_team_count++;
	}
	pthread_mutex_unlock(&link_team_mutex);
	fprintf(stderr, "server link: the peer at %08x plays on team %d\n", (unsigned)address, team);
}

/* the team planned for a machine by its address (either byte order, as the
game may hold it), or -1 */
int server_link_team_for_address(unsigned long address)
{
	uint32_t value = (uint32_t)address;
	uint32_t swapped = (value >> 24) | ((value >> 8) & 0xFF00u) | ((value << 8) & 0xFF0000u) | (value << 24);
	int team = -1;
	int index;

	pthread_mutex_lock(&link_team_mutex);
	for (index = 0; index < link_team_count; index++)
	{
		if (link_teams[index].address == value || link_teams[index].address == swapped)
		{
			team = link_teams[index].team;
			break;
		}
	}
	pthread_mutex_unlock(&link_team_mutex);
	if (team >= 0)
		fprintf(stderr, "server link: a player from %08lx joins team %d, as planned\n", address, team);
	return team;
}

/* the lobby's state and the host's kills, as the page's lobby tick read
them (online_client.js broadcastMatch, reportHostKills) */
static void *link_reporter(void *unused)
{
	unsigned char last[9] = { 0 };
	int ticks = 0;
	int kills_seen = platform_web_host_kill_sequence();
	long results_seen = network_lobby_result_sequence();

	(void)unused;
	for (;;)
	{
		struct timespec pause = { 0, LINK_STATUS_MILLISECONDS * 1000000L };
		unsigned char status[9];
		int16_t countdown = (int16_t)platform_web_online_get_countdown_remaining();
		uint16_t players = (uint16_t)platform_web_online_get_player_count();
		int sequence;

		status[0] = 'M';
		status[1] = (unsigned char)platform_web_online_get_match_state();
		memcpy(status + 2, &countdown, 2);
		memcpy(status + 4, &players, 2);
		status[6] = (unsigned char)(signed char)platform_web_online_get_client_state();
		status[7] = (unsigned char)platform_web_online_get_state();
		status[8] = 0;
		/* the match's result before the postgame it was captured for: read
		after the state, which the game publishes after capturing it */
		if (network_lobby_result_sequence() != results_seen)
		{
			long size;
			const unsigned char *result = network_lobby_result(&size);
			unsigned char message[1 + 400];

			results_seen = network_lobby_result_sequence();
			if (size > 0 && size < (long)sizeof(message) - 1)
			{
				message[0] = 'E';
				memcpy(message + 1, result, (size_t)size);
				link_send(message, (size_t)size + 1);
			}
		}
		if (memcmp(status, last, sizeof(status)) || ++ticks >= LINK_STATUS_REPEAT_TICKS)
		{
			link_send(status, 8);
			memcpy(last, status, sizeof(status));
			ticks = 0;
		}

		sequence = platform_web_host_kill_sequence();
		if (sequence < kills_seen)
			kills_seen = sequence;
		if (sequence - kills_seen > LINK_KILL_RING)
			kills_seen = sequence - LINK_KILL_RING;
		while (kills_seen < sequence)
		{
			const unsigned char *ring = platform_web_host_kills();
			unsigned char kill[1 + 2 * LINK_KILL_NAME];

			kill[0] = 'K';
			memcpy(kill + 1, ring + (kills_seen % LINK_KILL_RING) * 2 * LINK_KILL_NAME, 2 * LINK_KILL_NAME);
			kills_seen++;
			if (kill[1] && kill[1 + LINK_KILL_NAME])
				link_send(kill, sizeof(kill));
		}
		nanosleep(&pause, NULL);
	}
	return NULL;
}

/* The server draws nothing, so nothing (no display's refresh) paces its
main loop: each frame waits for the next 60th of a second. The game still
ticks at 30 Hz, and a frame comes soon enough after each tick. */
void server_link_frame(void)
{
	static struct timespec next;
	struct timespec now;
	const long frame_nanoseconds = 1000000000L / 60;

	clock_gettime(CLOCK_MONOTONIC, &now);
	if (!next.tv_sec ||
		now.tv_sec > next.tv_sec + 1)
	{
		/* the first frame, or one after a long stall: start over from now */
		next = now;
	}
	next.tv_nsec += frame_nanoseconds;
	if (next.tv_nsec >= 1000000000L)
	{
		next.tv_sec++;
		next.tv_nsec -= 1000000000L;
	}
	while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL) == EINTR)
		;
}

void server_link_start(void)
{
	const char *path = getenv("HALO_SERVER_LINK");
	struct sockaddr_un address;
	unsigned char hello[1 + LINK_IDENTIFIER_SIZE];
	pthread_t thread;
	int attempt;

	if (!path || !*path || strlen(path) >= sizeof(address.sun_path))
	{
		fprintf(stderr, "halo-server: HALO_SERVER_LINK must name the gateway's socket\n");
		exit(2);
	}
	memset(&address, 0, sizeof(address));
	address.sun_family = AF_UNIX;
	strcpy(address.sun_path, path);
	for (attempt = 0; attempt < LINK_CONNECT_SECONDS * 10; attempt++)
	{
		struct timespec pause = { 0, 100000000L };

		link_socket = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
		if (link_socket < 0)
			break;
		if (connect(link_socket, (struct sockaddr *)&address, sizeof(address)) == 0)
			break;
		close(link_socket);
		link_socket = -1;
		nanosleep(&pause, NULL);
	}
	if (link_socket < 0)
	{
		fprintf(stderr, "halo-server: cannot reach the gateway at %s\n", path);
		exit(2);
	}
	{
		int size = 4 << 20;

		setsockopt(link_socket, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));
		setsockopt(link_socket, SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));
	}
	platform_web_online_set_headless(1);
	hello[0] = 'I';
	memcpy(hello + 1, web_net_remote_local_identifier(), LINK_IDENTIFIER_SIZE);
	link_send(hello, sizeof(hello));
	if (pthread_create(&thread, NULL, link_reader, NULL) != 0 ||
		pthread_create(&thread, NULL, link_reporter, NULL) != 0)
	{
		fprintf(stderr, "halo-server: cannot start the link threads\n");
		exit(2);
	}
	fprintf(stderr, "halo-server: linked to the gateway at %s\n", path);
}
