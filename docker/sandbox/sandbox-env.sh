# Sourced by every bash in a sandbox: non-interactive ones (the agent's commands, `bash -c`) through BASH_ENV, and
# interactive ones (the Shell tab) through /etc/bash.bashrc. It only defines functions, so sourcing it has no effect
# until a command is missing: then bash calls command_not_found_handle, which says how to get the command instead
# of only "command not found". The catalog's commands are kept in step with src/sandbox/software.ts by its test.

command_not_found_handle() {
  local command=$1 software=""
  case $command in
    node | npm | npx | pnpm | yarn | corepack) software="node:Node.js 24" ;;
    convert | identify | mogrify | magick) software="imagemagick:ImageMagick" ;;
    ffmpeg | ffprobe) software="ffmpeg:FFmpeg" ;;
  esac
  printf 'bash: %s: command not found\n' "$command" >&2
  if [ -n "$software" ]; then
    printf '%s is Software (id "%s") the person can add from the conversation menu (Add software...); it then stays installed. To go on now: apt-get update && apt-get install -y <package>.\n' \
      "${software#*:}" "${software%%:*}" >&2
  else
    printf 'A Python tool: `uvx %s` runs it from PyPI without installing (`uvx --from <package> %s` when the names differ), or `pip install <package>`. Anything else: apt-get update && apt-get install -y <package> (apt has no package lists until apt-get update). What you install yourself is gone when this machine is replaced.\n' \
      "$command" "$command" >&2
  fi
  return 127
}
