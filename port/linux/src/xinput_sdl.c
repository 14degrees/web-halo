/*
XINPUT_SDL.C

Xbox controllers and the debug keyboard for the Linux build.

Port 0 is always connected: it is the keyboard and mouse, merged with the
first SDL gamepad when one is present. Further SDL gamepads take ports 1-3.

Keyboard and mouse (port 0), by default (the key map below; the browser
game's are slightly different and the player can rebind them there):
	W A S D         left stick          arrows           D-pad
	mouse            aim (see halo_linux_mouse_look)
	left button      right trigger       right button, G  left trigger
	space, enter     A                   F, backspace, X1 B
	E, R             X                   tab, wheel       Y
	Q                white               X                black
	left ctrl, C     left stick click    Z, middle button right stick click
	escape           start               F1               back
	F12              release or recapture the mouse

In the menus the mouse is free and drives a pointer instead
(port/linux/include/halo_ui_pointer.h, source/interface/ui_widget.c): its
motion, buttons and wheel do not reach the controller then.

Mouse aim does not go through the right stick: the game's look code asks
halo_linux_mouse_look for the motion since its last call and adds it to the
stick's facing change, so aiming is direct rather than rate based.

The game's debug keyboard exists only for the console. Backquote (which
opens it) always reaches the keystroke queue, everything else only while
the console is open, since the game also polls a few keys directly (escape
returns to the main menu). While the console is open the keyboard does not
drive the controller.
*/

#include "platform.h"
#include "sdl_platform.h"
#include "port_config.h"

#include <SDL3/SDL.h>
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define PORT_COUNT 4
#define VK_OEM_3_BACKQUOTE 0xc0

/* ---------- game hooks */

/* main/console.c */
extern unsigned char console_is_active(void);

/* ---------- device tables */

XPP_DEVICE_TYPE XDEVICE_TYPE_GAMEPAD_TABLE;
XPP_DEVICE_TYPE XDEVICE_TYPE_MEMORY_UNIT_TABLE;
XPP_DEVICE_TYPE XDEVICE_TYPE_DEBUG_KEYBOARD_TABLE;

struct controller
{
	BOOL open;
	DWORD packet_number;
	XINPUT_GAMEPAD previous;
};

static struct controller controllers[PORT_COUNT];
static struct controller keyboard_device;
static DWORD reported_gamepads = 0;
static BOOL reported_keyboard = FALSE;

/* ---------- mouse */

static pthread_mutex_t mouse_lock = PTHREAD_MUTEX_INITIALIZER;
static float mouse_pending_x, mouse_pending_y;
static unsigned long mouse_polls_unconsumed = 0;
static float mouse_wheel_accumulated = 0.0f;
/* the wheel's switch (wheel_update): when the wheel last moved, until when
Y is held, and whether a scroll is under way */
static Uint64 wheel_moved_ms = 0;
static Uint64 wheel_press_until_ms = 0;
static BOOL wheel_scrolling = FALSE;

/* How the mouse aims. The game thread reads these in halo_linux_mouse_look;
anything may change them mid-session through halo_linux_mouse_look_configure
(the browser page's slider does, through web_online_ui.c), so they are
atomics. Until something sets them they are "unknown" (0 and -1) and the
first look reads the config. */
static atomic_int mouse_sensitivity_thousandths = ATOMIC_VAR_INIT(0);
static atomic_int mouse_invert = ATOMIC_VAR_INIT(-1);

/* changes how the mouse aims from now on: sensitivity multiplies the default
turn per pixel (1.0; clamped to 0.05-10, anything else means 1.0), invert
makes moving the mouse forward look down. Any thread may call it. */
void halo_linux_mouse_look_configure(float sensitivity, int invert)
{
	if (!(sensitivity > 0.0f)) /* also NaN */
		sensitivity = 1.0f;
	if (sensitivity < 0.05f)
		sensitivity = 0.05f;
	if (sensitivity > 10.0f)
		sensitivity = 10.0f;
	atomic_store_explicit(&mouse_sensitivity_thousandths,
		(int)(sensitivity * 1000.0f + 0.5f), memory_order_relaxed);
	atomic_store_explicit(&mouse_invert, invert ? 1 : 0, memory_order_relaxed);
}

static float mouse_sensitivity(void)
{
	int thousandths = atomic_load_explicit(&mouse_sensitivity_thousandths, memory_order_relaxed);

	if (thousandths <= 0)
	{
		float configured = (float)config_real("input.mouse_sensitivity");
		int unknown = 0;

		if (configured <= 0.0f)
			configured = 1.0f;
		thousandths = (int)(configured * 1000.0f + 0.5f);
		if (thousandths <= 0)
			thousandths = 1;
		/* a value set meanwhile (unknown then holds it) beats the config's */
		if (!atomic_compare_exchange_strong(&mouse_sensitivity_thousandths, &unknown, thousandths))
			thousandths = unknown;
	}
	return (float)thousandths / 1000.0f;
}

static int mouse_inverted(void)
{
	int invert = atomic_load_explicit(&mouse_invert, memory_order_relaxed);

	if (invert < 0)
	{
		int unknown = -1;

		invert = config_boolean("input.invert_mouse") ? 1 : 0;
		if (!atomic_compare_exchange_strong(&mouse_invert, &unknown, invert))
			invert = unknown;
	}
	return invert;
}

/* radians of yaw and pitch for the mouse motion since the last call; the
game adds these to the facing change of the player on gamepad 0 */
int halo_linux_mouse_look(short gamepad_index, float *yaw, float *pitch)
{
	/* radians per pixel of relative motion at sensitivity 1 */
	const float scale = 0.0022f;
	float x, y;
	int invert;

	*yaw = 0.0f;
	*pitch = 0.0f;
	if (gamepad_index != 0)
		return FALSE;
	invert = mouse_inverted();
	pthread_mutex_lock(&mouse_lock);
	x = mouse_pending_x;
	y = mouse_pending_y;
	mouse_pending_x = 0.0f;
	mouse_pending_y = 0.0f;
	mouse_polls_unconsumed = 0;
	pthread_mutex_unlock(&mouse_lock);
	if (x == 0.0f && y == 0.0f)
		return FALSE;
	*yaw = -x * scale * mouse_sensitivity();
	*pitch = (invert ? y : -y) * scale * mouse_sensitivity();
	return TRUE;
}

/* collects the motion the game has not asked for yet; motion that nobody
consumes for a few polls (menus, cutscenes) is dropped so it cannot jerk
the view later */
static void mouse_poll(const struct platform_input_state *input)
{
	pthread_mutex_lock(&mouse_lock);
	if (++mouse_polls_unconsumed > 4)
	{
		mouse_pending_x = 0.0f;
		mouse_pending_y = 0.0f;
	}
	if (!input->mouse_released)
	{
		mouse_pending_x += input->mouse_dx;
		mouse_pending_y += input->mouse_dy;
		mouse_wheel_accumulated += input->mouse_wheel;
		if (input->mouse_wheel != 0.0f)
			wheel_moved_ms = SDL_GetTicks();
	}
	pthread_mutex_unlock(&mouse_lock);
}

/* ---------- the key map

What drives each control of the keyboard's controller: up to KEY_SLOTS
inputs per action, each a scancode, a mouse button or the wheel (the
KEY_INPUT_* codes, which the browser page's bindings dialog shares through
platform_web_set_key_binding). The page may change them mid-session from its
own thread, so they are atomics; 0 means the default below, which is also
what every slot holds until something sets it.

A few keys are fixed and not in the map, so the menus always work: escape
(start), F1 (back), enter (A) and backspace (B). */

enum
{
	KEY_ACTION_MOVE_FORWARD,
	KEY_ACTION_MOVE_BACK,
	KEY_ACTION_MOVE_LEFT,
	KEY_ACTION_MOVE_RIGHT,
	KEY_ACTION_JUMP, /* A */
	KEY_ACTION_MELEE, /* B */
	KEY_ACTION_ACTION, /* X: action and reload */
	KEY_ACTION_SWITCH_WEAPON, /* Y */
	KEY_ACTION_FLASHLIGHT, /* white */
	KEY_ACTION_SWITCH_GRENADE, /* black */
	KEY_ACTION_GRENADE, /* left trigger */
	KEY_ACTION_FIRE, /* right trigger */
	KEY_ACTION_CROUCH, /* left stick click */
	KEY_ACTION_ZOOM, /* right stick click */
	KEY_ACTION_DPAD_UP,
	KEY_ACTION_DPAD_DOWN,
	KEY_ACTION_DPAD_LEFT,
	KEY_ACTION_DPAD_RIGHT,
	KEY_ACTION_SCORES, /* back */
	KEY_ACTION_COUNT
};

#define KEY_SLOTS 2
#define KEY_INPUT_DEFAULT 0
#define KEY_INPUT_NONE (-1)
/* scancodes are 1 to SDL_SCANCODE_COUNT - 1; the mouse comes after */
#define KEY_INPUT_MOUSE_BUTTON 1000 /* + SDL_BUTTON_* */
#define KEY_INPUT_WHEEL 1100
#define KEY_MOUSE(button) (KEY_INPUT_MOUSE_BUTTON + (button))
#define KEY_UNBOUND KEY_INPUT_NONE

static const int key_defaults[KEY_ACTION_COUNT][KEY_SLOTS] =
{
	[KEY_ACTION_MOVE_FORWARD] = { SDL_SCANCODE_W, KEY_UNBOUND },
	[KEY_ACTION_MOVE_BACK] = { SDL_SCANCODE_S, KEY_UNBOUND },
	[KEY_ACTION_MOVE_LEFT] = { SDL_SCANCODE_A, KEY_UNBOUND },
	[KEY_ACTION_MOVE_RIGHT] = { SDL_SCANCODE_D, KEY_UNBOUND },
	[KEY_ACTION_JUMP] = { SDL_SCANCODE_SPACE, KEY_UNBOUND },
	[KEY_ACTION_MELEE] = { SDL_SCANCODE_F, KEY_MOUSE(SDL_BUTTON_X1) },
	[KEY_ACTION_ACTION] = { SDL_SCANCODE_E, SDL_SCANCODE_R },
#ifdef HALO_WEB
	/* the browser game: Q switches weapons, T is the flashlight, Tab holds
	up the scores as in other shooters */
	[KEY_ACTION_SWITCH_WEAPON] = { SDL_SCANCODE_Q, KEY_INPUT_WHEEL },
	[KEY_ACTION_FLASHLIGHT] = { SDL_SCANCODE_T, KEY_UNBOUND },
#else
	[KEY_ACTION_SWITCH_WEAPON] = { SDL_SCANCODE_TAB, KEY_INPUT_WHEEL },
	[KEY_ACTION_FLASHLIGHT] = { SDL_SCANCODE_Q, KEY_UNBOUND },
#endif
	[KEY_ACTION_SWITCH_GRENADE] = { SDL_SCANCODE_X, KEY_UNBOUND },
	[KEY_ACTION_GRENADE] = { SDL_SCANCODE_G, KEY_MOUSE(SDL_BUTTON_RIGHT) },
	[KEY_ACTION_FIRE] = { KEY_MOUSE(SDL_BUTTON_LEFT), KEY_UNBOUND },
#ifdef HALO_WEB
	/* Control plus a movement key is a browser shortcut (Ctrl+W closes the
	 * tab, Ctrl+S opens Save, and Ctrl+D bookmarks). Keep web crouch on C so
	 * ordinary tab play cannot accidentally leave the game. */
	[KEY_ACTION_CROUCH] = { SDL_SCANCODE_C, KEY_UNBOUND },
#else
	[KEY_ACTION_CROUCH] = { SDL_SCANCODE_LCTRL, SDL_SCANCODE_C },
#endif
	[KEY_ACTION_ZOOM] = { SDL_SCANCODE_Z, KEY_MOUSE(SDL_BUTTON_MIDDLE) },
	[KEY_ACTION_DPAD_UP] = { SDL_SCANCODE_UP, KEY_UNBOUND },
	[KEY_ACTION_DPAD_DOWN] = { SDL_SCANCODE_DOWN, KEY_UNBOUND },
	[KEY_ACTION_DPAD_LEFT] = { SDL_SCANCODE_LEFT, KEY_UNBOUND },
	[KEY_ACTION_DPAD_RIGHT] = { SDL_SCANCODE_RIGHT, KEY_UNBOUND },
#ifdef HALO_WEB
	[KEY_ACTION_SCORES] = { SDL_SCANCODE_TAB, KEY_UNBOUND },
#else
	[KEY_ACTION_SCORES] = { KEY_UNBOUND, KEY_UNBOUND },
#endif
};

static atomic_int key_bindings[KEY_ACTION_COUNT][KEY_SLOTS];

/* binds one slot of an action from now on: a scancode, KEY_MOUSE(button),
KEY_INPUT_WHEEL, KEY_INPUT_NONE (nothing) or KEY_INPUT_DEFAULT; FALSE for an
unknown action, slot or input. Any thread may call it. */
int halo_linux_key_binding_configure(int action, int slot, int input)
{
	BOOL valid = input == KEY_INPUT_DEFAULT || input == KEY_INPUT_NONE || input == KEY_INPUT_WHEEL ||
		(input > SDL_SCANCODE_UNKNOWN && input < SDL_SCANCODE_COUNT) ||
		(input >= KEY_MOUSE(SDL_BUTTON_LEFT) && input <= KEY_MOUSE(SDL_BUTTON_X2));

	if (action < 0 || action >= KEY_ACTION_COUNT || slot < 0 || slot >= KEY_SLOTS || !valid)
		return FALSE;
	atomic_store_explicit(&key_bindings[action][slot], input, memory_order_relaxed);
	return TRUE;
}

static BOOL input_down(const struct platform_input_state *input, int code)
{
	/* the mouse and the wheel drive the controller only while captured */
	BOOL mouse = !input->mouse_released;

	if (code > SDL_SCANCODE_UNKNOWN && code < SDL_SCANCODE_COUNT)
		return input->keys[code] != 0;
	if (code >= KEY_MOUSE(SDL_BUTTON_LEFT) && code <= KEY_MOUSE(SDL_BUTTON_X2))
		return mouse && input->mouse_buttons[code - KEY_INPUT_MOUSE_BUTTON];
	if (code == KEY_INPUT_WHEEL)
		return mouse && SDL_GetTicks() < wheel_press_until_ms;
	return FALSE;
}

static BOOL action_down(const struct platform_input_state *input, int action)
{
	int slot;

	for (slot = 0; slot < KEY_SLOTS; slot++)
	{
		int code = atomic_load_explicit(&key_bindings[action][slot], memory_order_relaxed);

		if (code == KEY_INPUT_DEFAULT)
			code = key_defaults[action][slot];
		if (input_down(input, code))
			return TRUE;
	}
	return FALSE;
}

/* ---------- keyboard and mouse as a controller */

static BYTE analog(BOOL down)
{
	return down ? 0xff : 0x00;
}

static void keyboard_gamepad(const struct platform_input_state *input, XINPUT_GAMEPAD *pad)
{
	static const struct
	{
		int action;
		WORD mask;
	} digital[] =
	{
		{ KEY_ACTION_DPAD_UP, XINPUT_GAMEPAD_DPAD_UP },
		{ KEY_ACTION_DPAD_DOWN, XINPUT_GAMEPAD_DPAD_DOWN },
		{ KEY_ACTION_DPAD_LEFT, XINPUT_GAMEPAD_DPAD_LEFT },
		{ KEY_ACTION_DPAD_RIGHT, XINPUT_GAMEPAD_DPAD_RIGHT },
		{ KEY_ACTION_SCORES, XINPUT_GAMEPAD_BACK },
		{ KEY_ACTION_CROUCH, XINPUT_GAMEPAD_LEFT_THUMB },
		{ KEY_ACTION_ZOOM, XINPUT_GAMEPAD_RIGHT_THUMB },
	};
	static const struct
	{
		int action;
		int button;
	} analog_buttons[] =
	{
		{ KEY_ACTION_JUMP, XINPUT_GAMEPAD_A },
		{ KEY_ACTION_MELEE, XINPUT_GAMEPAD_B },
		{ KEY_ACTION_ACTION, XINPUT_GAMEPAD_X },
		{ KEY_ACTION_SWITCH_WEAPON, XINPUT_GAMEPAD_Y },
		{ KEY_ACTION_FLASHLIGHT, XINPUT_GAMEPAD_WHITE },
		{ KEY_ACTION_SWITCH_GRENADE, XINPUT_GAMEPAD_BLACK },
		{ KEY_ACTION_GRENADE, XINPUT_GAMEPAD_LEFT_TRIGGER },
		{ KEY_ACTION_FIRE, XINPUT_GAMEPAD_RIGHT_TRIGGER },
	};
	const unsigned char *k = input->keys;
	int x = 0, y = 0;
	size_t index;

	if (action_down(input, KEY_ACTION_MOVE_RIGHT)) x++;
	if (action_down(input, KEY_ACTION_MOVE_LEFT)) x--;
	if (action_down(input, KEY_ACTION_MOVE_FORWARD)) y++;
	if (action_down(input, KEY_ACTION_MOVE_BACK)) y--;
	if (x || y)
	{
		/* full deflection, diagonals on the unit circle */
		float length = (x && y) ? 0.70710678f : 1.0f;

		pad->sThumbLX = (SHORT)(x * 32767 * length);
		pad->sThumbLY = (SHORT)(y * 32767 * length);
	}

	for (index = 0; index < sizeof(digital) / sizeof(digital[0]); index++)
	{
		if (action_down(input, digital[index].action))
			pad->wButtons |= digital[index].mask;
	}
	for (index = 0; index < sizeof(analog_buttons) / sizeof(analog_buttons[0]); index++)
		pad->bAnalogButtons[analog_buttons[index].button] |= analog(action_down(input, analog_buttons[index].action));

	/* the fixed keys */
	if (k[SDL_SCANCODE_ESCAPE]) pad->wButtons |= XINPUT_GAMEPAD_START;
	if (k[SDL_SCANCODE_F1]) pad->wButtons |= XINPUT_GAMEPAD_BACK;
	pad->bAnalogButtons[XINPUT_GAMEPAD_A] |= analog(k[SDL_SCANCODE_RETURN] || k[SDL_SCANCODE_KP_ENTER]);
	pad->bAnalogButtons[XINPUT_GAMEPAD_B] |= analog(k[SDL_SCANCODE_BACKSPACE]);
#if defined(HALO_ANDROID) && !defined(HALO_WEB)
	/* the system back key (gesture or button) backs out of menus */
	pad->bAnalogButtons[XINPUT_GAMEPAD_B] |= analog(k[SDL_SCANCODE_AC_BACK]);
#endif
}

/* A scroll of the wheel switches weapons once: it holds Y for WHEEL_PRESS_MS
once the wheel has turned a notch, and the scroll lasts until the wheel has
been still for WHEEL_SCROLL_GAP_MS. One notch often arrives as several events
over a few tens of milliseconds (high-resolution and smooth-scrolling
wheels), and one flick turns several notches; switching for each would bring
the same weapon straight back. Timed in milliseconds, not polls: polls come
once a frame, at the display's refresh rate. */
#define WHEEL_PRESS_MS 50
#define WHEEL_SCROLL_GAP_MS 200

/* debug.test_input "bot:<seed>": a scripted player for the automated
network tests (port/linux/game/network_test.c), different for each seed:
it walks and strafes in circles, turns, fires every few seconds and jumps
now and then */
static int test_input_holding_action;
static Uint64 test_input_holding_action_since;

/* the automated tests (port/linux/game/network_test.c): the scripted player
stands still, holding the action button (X: picking up, swapping weapons)
after a second */
void test_input_hold_action(int hold)
{
	if (hold && !test_input_holding_action)
		test_input_holding_action_since = SDL_GetTicks();
	test_input_holding_action = hold;
}

static void test_input_gamepad(XINPUT_GAMEPAD *pad)
{
	static int checked;
	static int seed = -1;
	double t;

	if (!checked)
	{
		const char *setting = config_string("debug.test_input");

		checked = 1;
		if (!strncmp(setting, "bot:", 4))
			seed = atoi(setting + 4);
		else if (!strcmp(setting, "bot"))
			seed = 0;
	}
	if (seed < 0)
		return;
	if (test_input_holding_action)
	{
		/* (standing still, the button held from a second on) */
		if (SDL_GetTicks() - test_input_holding_action_since >= 1000)
			pad->bAnalogButtons[XINPUT_GAMEPAD_X] = 255;
		return;
	}
	t = (double)SDL_GetTicks() / 1000.0 + seed * 1.7;
	pad->sThumbLY = (SHORT)(sin(t * 0.9) * 32000.0);
	pad->sThumbLX = (SHORT)(cos(t * 0.6 + seed) * 20000.0);
	pad->sThumbRX = (SHORT)(sin(t * 0.4) * 14000.0);
	if (fmod(t, 3.0) < 0.3)
		pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER] = 255;
	if (fmod(t, 5.0) < 0.1)
		pad->bAnalogButtons[XINPUT_GAMEPAD_A] = 255;
}

static void wheel_update(void)
{
	Uint64 now = SDL_GetTicks();

	pthread_mutex_lock(&mouse_lock);
	if (!wheel_scrolling)
	{
		if (fabsf(mouse_wheel_accumulated) >= 1.0f)
		{
			wheel_scrolling = TRUE;
			wheel_press_until_ms = now + WHEEL_PRESS_MS;
		}
	}
	else if (now >= wheel_press_until_ms && now - wheel_moved_ms >= WHEEL_SCROLL_GAP_MS)
	{
		wheel_scrolling = FALSE;
		mouse_wheel_accumulated = 0.0f;
	}
	pthread_mutex_unlock(&mouse_lock);
}

/* ---------- SDL gamepads */

/* the SDL gamepads in connection order, at most one per port */
static int sdl_gamepads(SDL_Gamepad *gamepads[PORT_COUNT])
{
	SDL_JoystickID *ids;
	int count = 0, index, found = 0;

	memset(gamepads, 0, sizeof(SDL_Gamepad *) * PORT_COUNT);
	ids = SDL_GetGamepads(&count);
	if (!ids)
		return 0;
	#if defined(HALO_ANDROID) && !defined(HALO_WEB)
	{
		/* Android can list input devices with a few gamepad buttons (the
		emulator's keyboard, some phones' key devices) as generic gamepads:
		recognised controllers take the first ports */
		int pass;

		for (pass = 0; pass < 2; pass++)
		{
			for (index = 0; index < count && found < PORT_COUNT; index++)
			{
				SDL_Gamepad *gamepad = SDL_GetGamepadFromID(ids[index]);
				SDL_GamepadType type;
				BOOL recognised;

				if (!gamepad)
					continue;
				type = SDL_GetGamepadType(gamepad);
				recognised = type != SDL_GAMEPAD_TYPE_UNKNOWN && type != SDL_GAMEPAD_TYPE_STANDARD;
				if (recognised == (pass == 0))
					gamepads[found++] = gamepad;
			}
		}
	}
#else
	for (index = 0; index < count && found < PORT_COUNT; index++)
	{
		SDL_Gamepad *gamepad = SDL_GetGamepadFromID(ids[index]);

		if (gamepad)
			gamepads[found++] = gamepad;
	}
#endif
	SDL_free(ids);
	return found;
}

static SHORT stick(Sint16 value, BOOL flip)
{
	int result = flip ? -(int)value - 1 : value;

	if (result < -32768) result = -32768;
	if (result > 32767) result = 32767;
	return (SHORT)result;
}

static void merge_button(XINPUT_GAMEPAD *pad, int analog_index, BOOL down)
{
	if (down)
		pad->bAnalogButtons[analog_index] = 0xff;
}

static void sdl_gamepad_state(SDL_Gamepad *gamepad, XINPUT_GAMEPAD *pad)
{
	static const struct
	{
		SDL_GamepadButton button;
		WORD mask;
	} digital[] =
	{
		{ SDL_GAMEPAD_BUTTON_DPAD_UP, XINPUT_GAMEPAD_DPAD_UP },
		{ SDL_GAMEPAD_BUTTON_DPAD_DOWN, XINPUT_GAMEPAD_DPAD_DOWN },
		{ SDL_GAMEPAD_BUTTON_DPAD_LEFT, XINPUT_GAMEPAD_DPAD_LEFT },
		{ SDL_GAMEPAD_BUTTON_DPAD_RIGHT, XINPUT_GAMEPAD_DPAD_RIGHT },
		{ SDL_GAMEPAD_BUTTON_START, XINPUT_GAMEPAD_START },
		{ SDL_GAMEPAD_BUTTON_BACK, XINPUT_GAMEPAD_BACK },
		{ SDL_GAMEPAD_BUTTON_LEFT_STICK, XINPUT_GAMEPAD_LEFT_THUMB },
		{ SDL_GAMEPAD_BUTTON_RIGHT_STICK, XINPUT_GAMEPAD_RIGHT_THUMB },
	};
	int index;
	int left_trigger, right_trigger;
	SHORT value;

	for (index = 0; index < (int)(sizeof(digital) / sizeof(digital[0])); index++)
	{
		if (SDL_GetGamepadButton(gamepad, digital[index].button))
			pad->wButtons |= digital[index].mask;
	}
	merge_button(pad, XINPUT_GAMEPAD_A, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_SOUTH));
	merge_button(pad, XINPUT_GAMEPAD_B, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_EAST));
	merge_button(pad, XINPUT_GAMEPAD_X, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_WEST));
	merge_button(pad, XINPUT_GAMEPAD_Y, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_NORTH));
	/* the Duke's white and black buttons sit where later pads have shoulders */
	merge_button(pad, XINPUT_GAMEPAD_WHITE, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_LEFT_SHOULDER));
	merge_button(pad, XINPUT_GAMEPAD_BLACK, SDL_GetGamepadButton(gamepad, SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER));

	left_trigger = SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFT_TRIGGER) * 255 / 32767;
	right_trigger = SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) * 255 / 32767;
	if (left_trigger > pad->bAnalogButtons[XINPUT_GAMEPAD_LEFT_TRIGGER])
		pad->bAnalogButtons[XINPUT_GAMEPAD_LEFT_TRIGGER] = (BYTE)left_trigger;
	if (right_trigger > pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER])
		pad->bAnalogButtons[XINPUT_GAMEPAD_RIGHT_TRIGGER] = (BYTE)right_trigger;

	/* a stick only overrides the keyboard when it is pushed further */
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFTX), FALSE);
	if (abs(value) > abs(pad->sThumbLX)) pad->sThumbLX = value;
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFTY), TRUE);
	if (abs(value) > abs(pad->sThumbLY)) pad->sThumbLY = value;
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHTX), FALSE);
	if (abs(value) > abs(pad->sThumbRX)) pad->sThumbRX = value;
	value = stick(SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHTY), TRUE);
	if (abs(value) > abs(pad->sThumbRY)) pad->sThumbRY = value;
}

/* ---------- XAPI */

VOID WINAPI XInitDevices(DWORD preallocation_type_count, PXDEVICE_PREALLOC_TYPE preallocation_types)
{
	(void)preallocation_type_count;
	(void)preallocation_types;
	platform_sdl_initialize();
}

static DWORD connected_gamepads(void)
{
	SDL_Gamepad *gamepads[PORT_COUNT];
	int count = sdl_gamepads(gamepads);
	DWORD mask = XDEVICE_PORT0_MASK;
	int port;

	/* the first pad shares port 0 with the keyboard */
	for (port = 1; port < count; port++)
		mask |= 1UL << port;
	return mask;
}

static int gamepad_index_for_port(int port)
{
	return port;
}

BOOL WINAPI XGetDeviceChanges(PXPP_DEVICE_TYPE device_type, PDWORD insertions, PDWORD removals)
{
	*insertions = 0;
	*removals = 0;
	if (device_type == XDEVICE_TYPE_GAMEPAD)
	{
		DWORD connected = connected_gamepads();

		*insertions = connected & ~reported_gamepads;
		*removals = reported_gamepads & ~connected;
		reported_gamepads = connected;
	}
	else if (device_type == XDEVICE_TYPE_DEBUG_KEYBOARD)
	{
		if (!reported_keyboard)
		{
			*insertions = 1;
			reported_keyboard = TRUE;
		}
	}
	return *insertions || *removals;
}

HANDLE WINAPI XInputOpen(PXPP_DEVICE_TYPE device_type, DWORD port, DWORD slot,
	PXINPUT_POLLING_PARAMETERS polling_parameters)
{
	(void)slot;
	(void)polling_parameters;
	if (device_type == XDEVICE_TYPE_GAMEPAD && port < PORT_COUNT)
	{
		memset(&controllers[port], 0, sizeof(controllers[port]));
		controllers[port].open = TRUE;
		return (HANDLE)&controllers[port];
	}
	if (device_type == XDEVICE_TYPE_DEBUG_KEYBOARD && port == 0)
	{
		keyboard_device.open = TRUE;
		return (HANDLE)&keyboard_device;
	}
	SetLastError(ERROR_DEVICE_NOT_CONNECTED);
	return NULL;
}

VOID WINAPI XInputClose(HANDLE device)
{
	struct controller *controller = (struct controller *)device;

	if (controller)
		controller->open = FALSE;
}

static int controller_port(HANDLE device)
{
	int port;

	for (port = 0; port < PORT_COUNT; port++)
	{
		if (device == (HANDLE)&controllers[port] && controllers[port].open)
			return port;
	}
	return -1;
}

DWORD WINAPI XInputGetState(HANDLE device, PXINPUT_STATE state)
{
	int port = controller_port(device);
	SDL_Gamepad *gamepads[PORT_COUNT];
	int gamepad_index;
	int count;

	memset(state, 0, sizeof(*state));
	if (port < 0)
		return ERROR_DEVICE_NOT_CONNECTED;
	platform_pump_events();
	count = sdl_gamepads(gamepads);
	if (port == 0)
	{
		struct platform_input_state input;

		platform_input_read(&input, TRUE);
		mouse_poll(&input);
		wheel_update();
		if (!console_is_active())
			keyboard_gamepad(&input, &state->Gamepad);
		if (count > 0)
			sdl_gamepad_state(gamepads[0], &state->Gamepad);
		test_input_gamepad(&state->Gamepad);
	}
	else
	{
		gamepad_index = gamepad_index_for_port(port);
		if (gamepad_index >= 0 && gamepad_index < count)
			sdl_gamepad_state(gamepads[gamepad_index], &state->Gamepad);
	}

	if (memcmp(&state->Gamepad, &controllers[port].previous, sizeof(state->Gamepad)))
	{
		controllers[port].packet_number++;
		controllers[port].previous = state->Gamepad;
	}
	state->dwPacketNumber = controllers[port].packet_number;
	return ERROR_SUCCESS;
}

DWORD WINAPI XInputSetState(HANDLE device, PXINPUT_FEEDBACK feedback)
{
	int port = controller_port(device);
	SDL_Gamepad *gamepads[PORT_COUNT];
	int gamepad_index;
	int count;

	if (!feedback)
		return ERROR_INVALID_PARAMETER;
	feedback->Header.dwStatus = ERROR_SUCCESS;
	if (port < 0)
		return ERROR_DEVICE_NOT_CONNECTED;
	count = sdl_gamepads(gamepads);
	gamepad_index = gamepad_index_for_port(port);
	if (gamepad_index >= 0 && gamepad_index < count)
	{
		/* the game refreshes the motors every frame; rumble a little longer
		than that so they do not stutter */
		SDL_RumbleGamepad(gamepads[gamepad_index], feedback->Rumble.wLeftMotorSpeed,
			feedback->Rumble.wRightMotorSpeed, 100);
	}
	return ERROR_SUCCESS;
}

DWORD WINAPI XInputDebugInitKeyboardQueue(PXINPUT_DEBUG_KEYQUEUE_PARAMETERS parameters)
{
	(void)parameters;
	return ERROR_SUCCESS;
}

DWORD WINAPI XInputDebugGetKeystroke(PXINPUT_DEBUG_KEYSTROKE keystroke)
{
	struct platform_keystroke next;

	memset(keystroke, 0, sizeof(*keystroke));
	while (platform_next_keystroke(&next))
	{
		BOOL key_up = (next.flags & XINPUT_DEBUG_KEYSTROKE_FLAG_KEYUP) != 0;

		/* key ups always pass, so no key is left latched down */
		if (key_up || next.virtual_key == VK_OEM_3_BACKQUOTE || console_is_active())
		{
			keystroke->VirtualKey = next.virtual_key;
			keystroke->Ascii = next.ascii;
			keystroke->Flags = next.flags;
			return ERROR_SUCCESS;
		}
	}
	return ERROR_HANDLE_EOF;
}
