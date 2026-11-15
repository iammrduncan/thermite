# implement

Builds the project's own implementation of a change an outside pull request proposed, and commits
it with the contributor as co-author. **It writes files and makes local commits.** It does not
push, open a pull request, merge, comment or close anything.

## Before you start

- An `audit` of this pull request exists, and the owner chose **take** or **take in part**. With no
  audit, run it first.
- The owner chose how it ships. This playbook is the default: the project's own implementation.
  [Merging their commits](#the-other-way-merge-their-commits) is at the end.
- You know the branch the project's rules name for this work: the open release branch, or a fix
  branch from the main branch. Never commit on the contributor's branch.

## 1. Plan it as the project plans

A small fix needs no plan. Anything larger is planned the way the project plans its own work, in a
phase doc, a goal or an issue, with the pull request named as where the request came from. Quote
the contributor's own description of the problem there.

## 2. Build from the problem, not from the diff

1. **Start with the test that fails.** Bring the contributor's tests into the project's test
   layout first. They are often the best part of the pull request, and they are their work. Confirm
   they fail before the fix. Where they wrote none, write the failing test yourself.
2. **Write the fix the project's way:** where its conventions put the code, with its names, its
   helpers, and the smallest change that makes the test pass.
3. **Cover what the audit found they missed:** the other paths, the other tests that assert the
   old behavior, the upgrade from the last release.
4. **Update the docs** that describe what changed, and search them for the old behavior's words.
5. **Leave alone what they should not have changed:** restore a released changelog section or a
   shipped migration they edited.

Use their code where it is what the project would write. Do not rewrite a correct line to make the
result look different. Different on purpose, the same where the same is right.

Copying their lines is covered when the project's contributing terms say a contribution is
published under the project's license. Where the project states no such terms, tell the owner
before any of their lines are kept.

## 3. The changelog line

Add the line where the project's changelog collects unreleased work, in its house form. End it
with the credit:

```markdown
([pull request 80](https://github.com/<owner>/<repo>/pull/80), from <the contributor>)
```

Name the issue it closes too, when there is one. The line goes in the section of the release that
ships it, never in a released one.

## 4. Commit, with the contributor as co-author

**The final commit of the implementation carries the trailer.** When the implementation is one
commit, that is the one. When it is several, each commit that carries the contributor's idea may
have it, and the last one must. A later commit for something outside the pull request's scope, such
as a review finding in code they never touched, is the project's alone and has no trailer.

### The contributor's name and address

Use the host's no-reply address, which the host links to their account whatever email they commit
with. On GitHub:

```sh
gh api users/<login> --jq '{id, login, name}'
```

- **The address** is `<id>+<login>@users.noreply.github.com`.
- **The name** is the profile's `name`. When it is empty, use the login.
- **Never use an email taken from their commits.** It may be personal, and a commit message is
  public for good.
- **Several people wrote the pull request?** One trailer for each, from the authors of its
  commits. Leave out bots and coding agents.

### The message

```text
<What changed, as a plain sentence in the project's commit style>

<Why: the problem, who hit it, and what the fix does, in the project's own words.>

Built from pull request <N> by <name>: <what was kept>. <What was done differently, and why.>

Co-authored-by: <name> <<id>+<login>@users.noreply.github.com>
```

An example, for a change taken as it was reviewed. The name and the number are made up:

```text
An OpenAI-compatible provider may have no key, and its calls go with none

A model server that takes no key, such as llama.cpp or Ollama run
without one, could not be added: control refused a new provider with no
key, and the way round was a made-up key that the server got on every
call (issue 76, its first item).

[…what each path now does…]

Taken from pull request 80 by Ada Example, as it was reviewed; its
changelog line goes under v0.2.3.

Co-authored-by: Ada Example <1234567+ada-example@users.noreply.github.com>
```

### The trailer's form

The host reads a co-author only when the trailer is exact:

- The key is `Co-authored-by:`, then one space, the name, and the address in angle brackets.
- Trailers are the last lines of the message, after one blank line, one to a line, with no blank
  line between them.
- The project's own rule decides whether an agent adds a trailer for itself. Follow its
  instructions, and do not add one by default.
- Write no `@` before a login, and no bare `#N` that is not a real issue or pull request.

Check it after committing:

```sh
git log -1 --format='%(trailers:key=Co-authored-by)'
```

## 5. Check it

- The tests brought from the pull request fail without the fix and pass with it.
- Every gate the project's instructions list has run. Report each as passed, failed or not run.
- The commit holds no private name, host, path or personal email. A file scan does not read commit
  messages, so read the message yourself.

## Hand-off

One short message:

- **The commits,** one line each, and which carry the trailer.
- **What was kept** from the pull request, **what was done differently** and why, and **what was
  added** that it did not have.
- **The checks,** in a table.
- **What is left** from the pull request for later, and where that is recorded.
- **What happens next:** the owner pushes and releases. After the release is published, `respond`
  drafts the comment for the contributor.

## The other way: merge their commits

When the owner chooses to ship the contributor's own commits:

1. Merge the pull request's head into the project's branch with a merge commit whose subject says
   what it brings: `Merge pull request <N> from <login>: <what it does>`.
2. Put each change made on top in its own commit, named for the review finding it fixes, with a
   test of the finding.
3. Move the contributor's changelog line into the section of the release that ships it, in the
   house form, with the credit. Undo any edit they made to a released section.
4. When the branch reaches the base branch through a merge, the host marks their pull request as
   merged by itself.

No trailer is needed: their commits carry their name.
