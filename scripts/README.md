# scripts/

Operational scripts. `probe-edge.sh` reads `~/.config/coreprt/buzz-mcp.env`
and verifies the CF Access service token is admitted by the edge for the
`coreprt.webrnds.com` application. Reads the secret from the env file but
never echoes it to stdout. Exit 0 on edge 200s, non-zero on edge 403.
