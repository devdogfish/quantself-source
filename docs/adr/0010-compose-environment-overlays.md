# Compose environment overlays

Quantself defines one shared Compose service topology, then applies explicit development and production overlay files. This keeps service relationships consistent while allowing development source watching and local ports to differ from production's immutable images, restart policies, and private networking; profiles are reserved for optional services rather than environments.
