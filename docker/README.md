# turri in Docker

Everything **turri** needs - Node, git, bash, bubblewrap for the OS sandbox and **turri** itself - in one image, on
macOS, Linux and Windows alike, with nothing but Docker on the machine.

## Add your toolchains

**turri** runs the code it regenerates - the unit and conformance testing scripts, the apps it releases - inside the
container, so the image needs the toolchains your projects use: Python, Java, Go, ... Uncomment the example `RUN` line
in the [`Dockerfile`](Dockerfile) and list them there before you build.

## Build

From the root of the clone, once - and again after you pull a newer **turri** or change the toolchains:

```bash
docker build -f docker/Dockerfile -t turri .
```

## Run

In your project's folder, mounted at `/work`:

```bash
cd ~/my-project
docker run -it --rm -v "$PWD:/work" turri init-config     # once: asks your vendor, writes config.yaml
docker run -it --rm -v "$PWD:/work" -e ANTHROPIC_API_KEY -e GEMINI_API_KEY \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
  turri
```

To skip the question, name the vendor - `anthropic`, `openai`, `google` or `other`. With nothing to ask, it needs no `-it`:

```bash
docker run --rm -v "$PWD:/work" turri init-config --vendor anthropic
```

Without `-it` and without `--vendor`, it does not ask: it writes `other`, a mix of Anthropic and Google.

On Windows, in PowerShell, write `${PWD}` for `$PWD` and end the continued lines with a backtick `` ` `` instead of
`\`.

- **Keys.** `init-config` says which key its models need - for other, an Anthropic model to talk to and a Google one
  for the coding, so both keys are passed here.
  An `-e NAME` hands on the variable only if it is set in your shell: export each key first, pass the ones your
  `config.yaml`'s models need, or skip them and type `/login` once **turri** has started. What `/login` saves lives
  in the container and goes with it - mount a folder at `/home/node/.pi` to keep it.
- **The sandbox.** The three `--security-opt` let bubblewrap start inside the container. Without them the command
  check and the audit hold alone; `turri doctor` in place of `turri` says which wall is up.
- **Your files stay yours.** The container starts as root only to take the owner of the folder mounted at `/work`,
  then runs **turri** as that user (`entrypoint.sh`) - so on Linux what it writes is yours whatever your uid, and on
  Docker Desktop (macOS, Windows) it writes as the mount allows. bubblewrap would not start as root anyway.

See [installation](../docs/installation.md) and [the sandbox](../docs/sandbox.md) for what the checks and the walls
are.
