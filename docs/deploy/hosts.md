# Hosts

Any 64-bit Linux machine with Docker Engine runs a deployment: the Sandbox images are `ubuntu:24.04`, and the pi-env daemon ships amd64 and arm64 builds. The host needs Docker with Compose, bash and curl; `deploy/deploy.sh` builds everything else. Put your user in the `docker` group.

What every host shares:

- The server gets the host's Docker socket: it starts the Sandboxes as the host's containers, beside it. That socket is root on the host.
- Every service uses the host's network. The server opens each desktop's VNC port, which Docker publishes on the host's 127.0.0.1.
- SearXNG (`pnpm searxng:up`) is light and gives the agent `web_search`; Langfuse (`pnpm langfuse:up`) needs a machine that runs ClickHouse. The edge can serve their UIs, and SeaweedFS's admin, to the operator's account: [services.md](services.md). To keep files and the database in S3 on SeaweedFS: [storage.md](storage.md).
- Limit each Sandbox so an agent's build cannot starve the host: `SANDBOX_MEMORY_MB` (swap included) and `SANDBOX_CPUS` in `.env`, and `MAX_SHELLS` / `MAX_DESKTOPS` for how many run at once.

## Raspberry Pi 4 (8 GB)

A 64-bit OS (Raspberry Pi OS 64-bit or Ubuntu arm64). 8 GB of RAM is comfortable; lower `MAX_SHELLS` on smaller boards, and leave desktops off below 8 GB.

```sh
MAX_DESKTOPS=1
MAX_SHELLS=2
SANDBOX_MEMORY_MB=2048
SANDBOX_CPUS=2
```

A desktop with Chrome runs, one at a time, slowly:

- Chrome: Google ships it for arm64 Linux since July 2026, and every Sandbox image has it.
- Memory: XFCE, Xvfb and the VNC server take a few hundred MB; Chrome with a few tabs about 1 to 1.5 GB. With the server, the console and Docker, one desktop plus a couple of shells fits in 8 GB.
- CPU is the limit, not RAM: Xvfb has no GPU, so Chrome draws everything in software on the Pi 4's four Cortex-A72 cores. Ordinary pages are usable; video, maps and heavy animation are not. Keep the screen small (the image's default 1280x800).
- Disk: the desktop image plus Chrome is several GB, and Docker writes a lot. Boot from a USB 3 SSD rather than the SD card.
- Cooling: sustained software rendering throttles a Pi 4 without a heatsink or fan.
- Langfuse cannot run on a Pi 4: ClickHouse's arm64 builds stop with `Illegal instruction` on its Cortex-A72 (ARMv8.0). A Pi 5 or another machine can host it.

A model comes from an API key (`ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`) or from Ollama on another machine (`OLLAMA_URL`).

## A desktop with a GPU, running Ollama

The server container uses the host's network, so Ollama on the same machine is `OLLAMA_URL=http://127.0.0.1:11434`.

An Ollama model without `num_ctx` in its Modelfile is taken to have a 4096-token context, too small for the agent's tools and prompt. Make a variant with a larger one and set `MODEL_ID` to it. On an 8 GB GPU (a GTX 1070 Ti), `qwen3.5:9b` at 32k fits entirely in video memory: about 18 tokens/s out and 200 tokens/s of prompt, and it picks tool arguments far better than `qwen2.5:3b`:

```sh
ollama pull qwen3.5:9b
printf 'FROM qwen3.5:9b\nPARAMETER num_ctx 32768\n' > /tmp/Modelfile
ollama create qwen3.5:9b-32k -f /tmp/Modelfile
```

```sh
MODEL_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
MODEL_ID=qwen3.5:9b-32k
```

## A VPS

Nothing differs from the others. Prefer `tailscale` or `cloudflare` over `lan`: on a VPS the "local network" is the provider's, and `lan` would put plain http on its public interface.
