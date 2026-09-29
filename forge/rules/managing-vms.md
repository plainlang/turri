---
description: Rules for managing the sandbox VM a project is built in - its image, against the implementation reqs
---

# Rules for managing the sandbox VM

Every command an agent runs while building a project - its shell, the builds, the tests - runs in a
sandbox VM. What that VM can build is what its image holds. So the image has to hold what the
project's `***implementation reqs***` say the code is written and built with: a Java project needs
Java in its image, a Zig project Zig. The `<sandbox VM>` block in your context says, every turn,
which image the project runs, what it holds, and what the implementation reqs need of it that it
lacks.

## The three images

- **The default image, as it is.** plainwright's recipe: Python, Node, Java, Go, Rust, C/C++ and the
  basics. Nothing to write. Right for most projects, and for trying things.
- **The default image, changed** - for every project on this machine. The person's own file,
  `~/.plainwright/vm-image.json`, kept across plainwright's updates: `{ "remove": ["java", "python"],
  "add": ["zig"] }`, or `{ "packages": [...] }` to define it in full. Right when the person never uses
  a toolchain, or always uses one the recipe lacks.
- **The project's own image** - for one project. `vm-image:` in its `config.yaml`, the same keys, over
  the person's file. Built under a tag of the project's own; every VM of the project runs it. Right
  when a project's stack is not the default's - an Odin or Zig codebase, a project that needs none of
  the default's heavy toolchains.

`remove` takes toolchains by name - `python`, `node`, `java`, `go`, `rust`, `c` - or Alpine packages;
`add` and `packages` take Alpine package names (`zig`, `odin`, `ruby`, `php83`). The basics - git,
bash, curl, the file tools and what the VM needs to boot - are in every image, whatever a list says.
Never edit plainwright's own recipe, `vm/image.json`: the next update puts it back.

## Where it comes from

Everything in an image is Alpine Linux: its base system and every package, with all they depend
on, from Alpine's own repositories - `main` and `community`, on `dl-cdn.alpinelinux.org`, for the
Alpine release the recipe builds on. Nothing else is downloaded into it. When the person asks what
they are getting - which Python, from where, how big - `build_vm_image` with `plan: true` answers
it without building: every package the recipe names, its version, repository, the project it is
built from, its licence and size, what each toolchain costs beyond the basics, and any name the
repositories do not have. Show that before a build that changes what the image holds.

Where it comes from can be steered, in the person's file or a project's `vm-image:`: `mirror` - a
server in dl-cdn's layout, a nearer mirror or the company's own - for the base system, the kernel and
the packages, and `repositories` - the package repositories exactly, in place of `main` and
`community`. Set them only when the person asks, or when dl-cdn cannot be reached from where they
are, and only to servers they name: what a mirror serves goes into the image as it is. The image
keeps the repositories, so `system-packages` and `install_system_packages` install from them too.
Changing them takes a rebuild.

A toolchain Alpine does not package - Odin, in Alpine 3.23 - cannot be added by name: the build
stops on it and says so. It has to be installed another way, in the project - its own install
script, or the language's own installer run by the build.

## Against the implementation reqs

- Before the first build of a project, and whenever its implementation reqs change the stack, read
  the `<sandbox VM>` block: each module's implementation reqs, what they need, and what the image
  lacks. The block's reading is by keyword - check the reqs yourself when it says nothing or seems
  wrong.
- A toolchain the reqs need and the image lacks is added before building: to the project's own
  image for that project's stack, to the person's file for what they always use. A build started
  without it fails in the VM - the tests cannot run - and every attempt is lost.
- Never remove a toolchain any module of the project needs. Remove only what no implementation req
  of the project uses, and say what it saves: a smaller image builds and starts faster and takes
  less disk.
- A small library or tool one build needs - `sqlite`, `jq`, `libpq-dev` - is not a reason for an
  image of its own: put it in `system-packages:` in the project's `config.yaml`, which every VM of
  the project installs when it starts, or let the coding agent install it with
  `install_system_packages`.

## Writing and building

- Write the change with the file tools - the person's file, or `vm-image:` in the project's
  `config.yaml` - and then build it with `build_vm_image` (`scope: "project"` for the project's own,
  `"default"` for the person's). Say before you start what the image will hold and that the build
  takes minutes - about 7 with every toolchain, less with fewer.
- A build is only needed when the recipe changed: the `<sandbox VM>` block says when the image was
  not built with what its recipe now asks for.
- Every VM started after the build runs the new image; one already running keeps its own. A project
  whose own image is not built yet runs the default one meanwhile - its builds may lack what its image
  would add.
- The stock image - what runs before any image is built - holds only Python and Node, with about
  80 MB free: anything more takes a built image.
