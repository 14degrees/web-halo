# The game server image with the game data, for a platform without volumes
# mounted at start (Fly.io). Build context: a folder holding maps/.
FROM halo-game-server
COPY --chown=halo:halo maps/ /data/maps/
