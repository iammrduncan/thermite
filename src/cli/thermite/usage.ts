/**
 * The command line's usage text: `thermite help` prints it, and so does a command given wrongly
 * (which exits 2). The docs check (scripts/docs/check.mjs) reads every command and option from it.
 */
export const USAGE = `usage: thermite <command> [options]

  doctor [--control URL] [--model-url URL] [--port N] [--json]
                                      check this machine: the container engine and its compose
                                      tool, control's port, disk, the clock, the GPU driver and
                                      container toolkit where there is a GPU, and whether control
                                      and the model server answer. It says how to fix each
                                      problem, and exits 1 when a check fails
  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  token new --out F                   make a control token: write it to F (mode 0600; keep it,
                                      for example in a password manager) and print its SHA-256,
                                      the only part control's deployment needs
  assign --contract F --run ID [--seed GIT_URL[@COMMIT] | --seed-commit C]
         [--kit GIT_URL | --kit control:NAME]
         [--model NAME=URL ...] [--note TEXT] [--agents off] [--promotion auto|owner]
         [--ask gain:PERCENT|flaws|reviews|not-possible ...]
         [--queue-from RUN] [--mcp-servers JSON|@file]
         [--context-window TOKENS] [--compact-at PERCENT]
         [--info-file F] [--link URL ...] [--idea TEXT ...] [--hypothesis TEXT ...]
         (--control URL --token-file F --rig R [--ttl MIN] | --print)
                                      start a run. The rig's supervisor fetches the project and
                                      kit commits from their repositories, and models from their
                                      URLs, before the harness checks them. --seed-commit names a
                                      commit already on the rig (an earlier run's result); a kit
                                      already there needs no --kit. --kit control:NAME fetches
                                      the kit NAME that control keeps (kit add, or one the New
                                      campaign page wrote). --queue-from starts the new
                                      run's queue with a past run's untried experiments, read
                                      from control, which knows the run by its name wherever it
                                      ran (it needs --control and --token-file, with --print
                                      too).
                                      --mcp-servers gives the MCP servers the kit's kit.json
                                      names, as in kit.json; the rig refuses a run whose list
                                      differs. --note keeps a text with the run (--direction,
                                      its old name, still works and says so). --context-window
                                      and --compact-at set the campaign's own context settings
                                      in the contract sent (its agents_context, over the file's):
                                      every agent's window is the lower of it and its own, and
                                      the point replaces the rig's; the contract's hash changes
                                      with them. --info-file, --link, --idea and --hypothesis
                                      give the campaign's brief in the contract sent, each in
                                      place of the file's: its additional information (Markdown,
                                      from file F), its starting links (a research campaign's
                                      seeds), its ideas to try (hill climb and goal) and its
                                      hypotheses, one per option. --print shows the payload (for
                                      issue_command over MCP) instead of issuing it
  assign-payload --contract F --run ID --seed-repo R --seed-commit C --bundle PATH
                 [--bundle-sha256 H] [--kit-repo R --kit-commit C --kit-bundle PATH
                 [--kit-bundle-sha256 H]] [--model NAME=SHA256:PATH ...] [--note TEXT] [--agents off]
                                      print an assign_campaign payload (bundle and model
                                      paths are relative to the rig's inbox)
  rig add RIG --control URL --token-file F --out DIR
                                      enroll a rig with control (owner's token): control makes
                                      its token, and DIR gets the files the rig's host needs
  rig token RIG --control URL --token-file F --out FILE
                                      give an enrolled rig a new token (the old one stops working)
  rig retire RIG --control URL --token-file F
                                      shut an enrolled rig out of control; its history stays
  rig list --control URL --token-file F [--json]
                                      list the rigs (owner's token): reporting, stale or
                                      offline, and each one's Thermite version against
                                      control's, with what to do when it is behind or refused
  runpod launch CLOUD --gpu G [--gpus N] [--cloud-type SECURE|COMMUNITY] [--datacenter DC]
         [--image I] [--disk GB] [--volume GB] [--rig NAME] [--enroll-within MIN]
         [--setting NAME=VALUE ...] [--spend-limit USD] [--idle-stop MIN|off]
         --control URL --token-file F
                                      spends money: launch a rig on the GPU cloud CLOUD from
                                      Providers (owner's token), a pod of the one-container rig
                                      image in pull mode. Defaults: 1 GPU, SECURE, any data
                                      center, control's rig image, a 40 GB disk, a 100 GB
                                      volume, no spend limit, no idle stop. --idle-stop MIN
                                      stops the pod after MIN minutes with no run at work;
                                      off: no idle stop
  runpod list [CLOUD] --control URL --token-file F [--json]
                                      list the rigs launched on GPU clouds (owner's token):
                                      each pod's status, price per hour, spend so far and limits
  runpod limits RIG [--spend-limit USD|off] [--idle-stop MIN|off] --control URL --token-file F
                                      set or clear a RunPod rig's spend limit and idle stop
                                      (owner's token)
  runpod stop RIG --control URL --token-file F
                                      stop a RunPod rig's pod (owner's token): its runs paused
                                      and its results sent out first; its volume stays
  runpod start RIG --control URL --token-file F
                                      start a stopped pod again, and resume the runs its stop
                                      paused; refused when RunPod has no GPU free (owner's token)
  runpod restart RIG --control URL --token-file F
                                      stop the pod and start it again (owner's token)
  runpod terminate RIG --control URL --token-file F
                                      remove the pod for good, once every result has left it;
                                      refused, with the pod kept running, when one can't leave
                                      (owner's token)
  runpod reset RIG --control URL --token-file F
                                      start a full reset of a RunPod rig: every result out,
                                      then the wipe after your confirmation (owner's token)
  runpod confirm-wipe RIG --control URL --token-file F
                                      confirm the wipe of the rig's full reset (owner's token)
  runpod cancel-reset RIG --control URL --token-file F
                                      cancel the rig's full reset before its wipe (owner's token)
  run start CAMPAIGN --rig R [--agents off] [--provider P --model M] [--promotion auto|owner]
         [--ask gain:PERCENT|flaws|reviews|not-possible ...]
         [--judge-gpus N] [--queue-from RUN] [--past ID ...] [--fresh]
         [--granted C ... | --no-granted] --control URL --token-file F
                                      start a run of a campaign control keeps (owner's token), as
                                      Start a run on the campaign's page does, with its checks and
                                      refusals: a campaign saved on the New campaign page or
                                      assigned before. --provider and --model give the rig's
                                      agents that model first: the run does not start, and the
                                      command exits 1; run it again once the rig has the model.
                                      --queue-from starts the queue with the untried experiments
                                      of a run of the campaign, by its name; --past adds
                                      items of Thermite's knowledge base by id. Its agents search
                                      the campaign's whole collection, or with --fresh only the
                                      run's own items, and every collection the campaign is
                                      granted, or those --granted names, or none with
                                      --no-granted; fixed as it starts. It prints the new
                                      run and its command id; a stopped RunPod pod starts first
  campaign copy FROM NAME [--mcp-servers-json FILE] [--context-window TOKENS]
         [--compact-at PERCENT] [--info-file F] [--link URL ...] [--idea TEXT ...]
         [--hypothesis TEXT ...] --control URL --token-file F
                                      copy a campaign control keeps (owner's token): a new
                                      campaign NAME with FROM's contract and kit, its own empty
                                      collection in Thermite's knowledge base and no runs. Start
                                      a run of it with run start. It prints the copy.
                                      --mcp-servers-json: for a research campaign, the MCP
                                      servers the copy's agents use instead, as a JSON list
                                      ([] for none). --context-window and --compact-at give the
                                      copy its own context settings, in place of FROM's. The copy
                                      keeps FROM's brief; --info-file (Markdown; an empty file
                                      for none), --link, --idea and --hypothesis give its own,
                                      each in place of FROM's
  campaign context CAMPAIGN [--context-window TOKENS] [--compact-at PERCENT]
         --control URL --token-file F
                                      set a campaign's own context settings for all its runs'
                                      agents (owner's token): every agent's window is the lower
                                      of TOKENS and its own model's, and PERCENT replaces the
                                      rig's compaction point. Control saves a new version of the
                                      campaign; runs started from then take it. Without either
                                      option, the settings are removed. It prints the version
  campaign additions CAMPAIGN [--add ROLE=FILE]... --control URL --token-file F
                                      set the owner's additions to a campaign's roles (owner's
                                      token): each --add gives ROLE's text, from FILE, added to
                                      that role's own instructions in every prompt of the
                                      campaign's runs. Control saves a new version of the
                                      campaign; runs started from then take it. Without --add, the
                                      additions are removed. It prints the version
  kit add NAME BUNDLE [--ref REF] [--force] --control URL --token-file F
                                      give control a kit repository written elsewhere, as a git
                                      bundle file (owner's token; at most 64 MiB): control keeps
                                      every commit with its id, and the kit's head is the
                                      bundle's HEAD, its only branch, or --ref (a branch, a tag or
                                      a commit). The head needs a valid kit.json at its top.
                                      --force replaces a head the new one does not descend from;
                                      the old head's commits stay. Rigs fetch it from control:
                                      assign --kit control:NAME. It prints the kit's head
  kit list --control URL --token-file F [--json]
                                      the kits control keeps (owner's or reader's token): each
                                      one's head, commits and kit.json's name and target
  kb search [WORDS...] [--query Q ...] [--mode words|exact] [--like ADDRESS] [--seen ADDRESS ...]
         [--collection C ...] [--kind K ...] [--outcome O ...] [--run R ...] [--slot S ...]
         [--offset N] [--limit N] --control URL --token-file F
                                      search Thermite's knowledge base (owner's token): items with
                                      any of the words, best first, each with its id, address,
                                      slot, outcome, an excerpt, why it matched, its passage in a
                                      long text and, for an experiment, its result; with how many
                                      matched, the next page, where the words land and how many
                                      items hold each word; no words: the newest. --query adds a
                                      search, fused with the words; --mode exact takes FTS5's
                                      syntax; --like finds more like an item; --seen leaves items
                                      out; --collection, --kind, --outcome, --run and --slot keep
                                      only those. It prints JSON
  kb read ADDRESS [--version N] [--offset N] --control URL --token-file F
                                      one item of the knowledge base, by its address
                                      (<campaign>/<run>/<slot>/<kind>:<id>): its newest version,
                                      or version N, with its text from --offset, 10,000
                                      characters at most, every version, its writer, withdrawn
                                      evidence, its file's facts, its links both ways and which
                                      running runs can read it. It prints JSON
  kb list [PLACE] [--kind K ...] [--outcome O ...] [--type T ...] [--slot S ...]
         [--sort S] [--order asc|desc] [--offset N] [--limit N] --control URL --token-file F
                                      what one place of the knowledge base holds, as the
                                      Knowledge page shows it: the whole knowledge base, or
                                      PLACE (<campaign>, <campaign>/<run> or
                                      <campaign>/<run>/<slot>): its folders (collections, runs or
                                      slots) and a page of every item under it, with how many
                                      and their counts by kind, outcome, type and slot. --type is
                                      record, blurb or file; --sort is name, kind, outcome,
                                      writer, modified (the default) or size; --limit 0 to 200
                                      (default 50). It prints JSON
  agents list --control URL --token-file F [--json]
                                      the agents' roles (owner's token): each
                                      one's name and what it does
  agents show ROLE [--run RUN [--prompt N] [--sections]] --control URL --token-file F [--json]
                                      a role's definition: its model, programs, the function
                                      that puts its prompt together and its fixed texts. With
                                      --run, the prompt the run's agent in that role was sent
                                      (the newest, or prompt N): each section with its source
                                      and text; --sections lists the sources only. Control has
                                      at most 8,000 characters of a prompt's own text; the
                                      whole is on the rig and in the run's export
  mcp list --control URL --token-file F [--json]
                                      the MCP servers in Settings (owner's token): each one's
                                      sign-in, state, last error, tools and the kits that name
                                      it. No secret, only its last four characters
  mcp add NAME --url URL --auth oauth|key|client|none [--header H] [--secret-file F]
          [--client-id ID] [--client-secret-file F] [--scope S] --control URL --token-file F
                                      add an MCP server (owner's token). key: --secret-file
                                      holds the header's whole value (Bearer and the token);
                                      client: --client-id and --client-secret-file. Control
                                      seals each secret and reads the server's tools. oauth:
                                      prints the sign-in page's address: open it and allow
                                      Thermite
  mcp change NAME [--url URL] [--auth oauth|key|client|none] [--header H] [--secret-file F]
          [--client-id ID] [--client-secret-file F] [--scope S] --control URL --token-file F
                                      change a server; a secret left out is kept, except for
                                      another address or another --auth, which needs it again
  mcp check NAME --control URL --token-file F
                                      read the server's tools again (it calls none)
  mcp sign-in NAME --control URL --token-file F
                                      print the address of an OAuth server's sign-in page
  mcp delete NAME --control URL --token-file F
                                      forget a server and its secrets; refused while a kit
                                      names it
  command --control URL --token-file F [--rig U] --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token). A
                                      kind about one run (its payload's run) goes to the rig the
                                      run is on, so --rig may be left out; every other kind
                                      needs it. assign_campaign and resume_run on a RunPod rig
                                      whose pod is stopped start the pod first, and say so
  invalidate --run RUN (--attempt ID | --job N) --reason TEXT [--yes] --control URL --token-file F
                                      withdraw bad evidence (owner's token): an attempt, for
                                      good, with every attempt built on it, or a judge job's
                                      measurements, whose attempts are judged again. It prints
                                      what it would reach, from the rig, and changes nothing;
                                      with --yes it then withdraws exactly that, or the rig
                                      refuses when what it reaches changed. Nothing is deleted
  submit --harness URL --token-file F --run ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  local init DIR [--engine docker|podman]
                                      make DIR, the local compose stack's .dev folder: random
                                      tokens in DIR/secrets, the inbox, the outbox, and the
                                      advisors' and backups' folders. Files that exist are
                                      kept. Run as root, it gives what it makes to the owner of
                                      DIR's parent folder. It says what the local rig gets
                                      (CPUs, memory, GPUs), and with NVIDIA GPUs the rig can
                                      have, writes compose.gpu.yaml next to DIR for the engine
                                      named, or the one it finds. Each rig's token for control
                                      starts empty: local enroll fills it
  local enroll RIG --control URL --token-file F --out FILE
                                      the compose stack's enroll step: wait for control (up to
                                      5 minutes), enroll RIG with the owner's token in F unless
                                      control has it enrolled and FILE holds a token, and write
                                      its token into FILE. A retired rig is left as it is
  selftest isolation [--force]        inside the harness container, as root, with the rig idle: check that role
                                      users cannot reach the ledger, kits, builds or secrets
  backup FOLDER [--state DIR] [--bus URL]
                                      where control's state folder is mounted (compose: the
                                      backup service): copy control's state (control.db, whole
                                      while control runs, its keys, kits and exports) and a
                                      snapshot of the bus's EVENTS stream into a new folder in
                                      FOLDER, named for the time, with a manifest of each file's
                                      SHA-256 and each stream's count and last place. --state:
                                      control's state folder (THERMITE_CONTROL_DIR, or
                                      /var/lib/thermite-control); --bus: the bus
                                      (THERMITE_NATS_URL)
  restore BACKUP [--state DIR] [--bus URL] [--control URL] [--bus-store DIR]
                                      with control stopped: check the backup against its
                                      manifest, restore each stream the bus does not have and
                                      check it (its count, last place and last message), then
                                      put control's state back, what it replaces moved aside
                                      into a dated folder. A stream on the bus is kept when it
                                      holds the backup's events unchanged, with or without
                                      newer ones after them; any other is refused, and nothing
                                      changes. --control: refused while control answers there.
                                      --bus-store DIR, with the bus stopped: only move the
                                      bus's store aside into a dated folder in DIR, so that
                                      the bus starts empty
`;
