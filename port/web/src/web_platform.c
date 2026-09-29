/* Browser-only filesystem mounts and small OpenGL ES host helpers. */

#include "platform.h"
#include "posix.h"
#include "gl.h"

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *const map_files[] =
{
	"a10.map", "a30.map", "a50.map", "b30.map", "b40.map", "c10.map",
	"c20.map", "c40.map", "d20.map", "d40.map", "beavercreek.map",
	"bloodgulch.map", "boardingaction.map", "carousel.map", "chillout.map",
	"damnation.map", "hangemhigh.map", "longest.map", "prisoner.map",
	"putput.map", "ratrace.map", "sidewinder.map", "ui.map", "wizard.map"
};

EMSCRIPTEN_KEEPALIVE void platform_web_set_muted(int muted)
{
	platform_audio_set_muted(muted ? TRUE : FALSE);
}

EMSCRIPTEN_KEEPALIVE double platform_web_profile_memory_bytes(void)
{
	return (double)emscripten_get_heap_size();
}

void platform_web_initialize(void)
{
	backend_t root = wasmfs_get_backend_by_path("/");
	backend_t maps;
	backend_t storage;
	unsigned long index;

	/* FetchFS performs HTTP range requests, so opening a map does not first
	download every map (or even all of the selected map). */
	/* The mountpoint is created inside this directory immediately below, so
	the parent must remain writable during startup. */
	if (wasmfs_create_directory("/assets", 0755, root) != 0 && errno != EEXIST)
		platform_log("web: cannot create /assets");
	/* FetchFS's whole-file fallback stores the file length as its per-file
	 * chunk size, while later range-residency checks continue using the
	 * configured chunk size. Sequential reads past that configured boundary
	 * enter inconsistent chunk bookkeeping. Every UI/multiplayer map is under
	 * 32 MiB, so it remains entirely in chunk zero even when a CDN does not
	 * advertise ranges. Campaign maps are over 64 MiB and stay on the ranged
	 * path when served by the local range-capable development server. */
	maps = wasmfs_create_fetch_backend("/assets/maps", 32 * 1024 * 1024);
	if (wasmfs_create_directory("/assets/maps", 0555, maps) != 0 && errno != EEXIST)
		platform_log("web: cannot mount the maps backend");
	for (index = 0; index < sizeof(map_files) / sizeof(map_files[0]); index++)
	{
		char path[128];
		int descriptor;

		snprintf(path, sizeof(path), "/assets/maps/%s", map_files[index]);
		descriptor = wasmfs_create_file(path, 0444, maps);
		if (descriptor >= 0)
			close(descriptor);
	}

	/* Origin-private storage persists configuration, cache files, profiles
	and saves without asking the browser to hold them in linear memory. */
	storage = wasmfs_create_opfs_backend();
	if (wasmfs_create_directory("/storage", 0777, storage) != 0 && errno != EEXIST)
		platform_log("web: cannot mount persistent storage");
	setenv("HALO_DATA_ROOT", "/assets", 1);
	setenv("HALO_SAVE_ROOT", "/storage", 1);
	setenv("HALO_NET_ONLINE", "false", 1);
	setenv("HALO_NET_JOIN_FROM_CLIPBOARD", "false", 1);
	setenv("HALO_FULLSCREEN", "false", 1);
	setenv("HALO_WINDOW_SCALE", "1", 1);
}

int host_gl_has_extension(const char *name)
{
	GLint count = 0;
	GLint index;

	glGetIntegerv(GL_NUM_EXTENSIONS, &count);
	for (index = 0; index < count; index++)
	{
		const char *extension = (const char *)glGetStringi(GL_EXTENSIONS, (GLuint)index);

		if (extension && !strcmp(extension, name))
			return TRUE;
	}
	return FALSE;
}

unsigned int host_gl_read_buffer_word(unsigned int buffer, unsigned int offset)
{
	(void)buffer;
	(void)offset;
	return 0;
}

void host_gl_buffer_write(unsigned int target, unsigned int offset, unsigned int size, const void *data)
{
	glBufferSubData((GLenum)target, (GLintptr)offset, (GLsizeiptr)size, data);
}

void host_gl_fence_frame(unsigned int slot)
{
	(void)slot;
	/* bufferSubData copies its input before returning, and presentation has
	already committed the WebGL command stream for this frame. */
}

void host_gl_wait_frame(unsigned int slot)
{
	(void)slot;
	/* WebGL copies bufferSubData input before returning.  glFinish on an
	OffscreenCanvas worker can wait on the browser compositor indefinitely,
	so the three-frame streaming ring needs no explicit CPU-side wait. */
}
