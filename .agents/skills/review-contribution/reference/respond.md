# respond

Drafts the comment that tells a contributor what happened to their pull request. **It writes no
files.** It posts to the code host, and closes a pull request, only after the owner has read the
exact text and said yes for this pull request.

## When

- **Shipped:** after the release that carries the change is published, so the comment can link it.
- **Held or declined:** as soon as the owner has decided.
- **Taken in part:** after the release, as for shipped.

## 1. Gather the facts

Read them from the repository and the host. Do not write them from memory.

- the release: its version and its link;
- the commit that carries the change, and each follow-up commit, by hash;
- the project's own pull request that shipped it, if there was one;
- what was done differently from their pull request, and why;
- what the review found and fixed on top;
- what was left for later, and where that is tracked.

## 2. Check the credit is in place

Before drafting, confirm each of these, and report any that is missing:

- The commit has the `Co-authored-by:` trailer, or their own commits were merged.
- The changelog line names the pull request and the contributor, in the shipped release's section.
- The release notes thank them in the line their work shipped in.

A comment must not claim credit that is not there.

## 3. Draft the comment

Write to the person. Thank them for the specific thing that was good. Say what shipped and where.
Say what changed and why, in a list they can check. Keep it short enough to read in one sitting.

**Shipped as the project's own implementation:**

```markdown
Thank you, this is a clean fix with tests that fail without it: it shipped in [v<version>](<release link>).

We took it into the release branch as a commit of ours, [<short hash>](<commit link>), with you
credited as its co-author, and released it from [pull request <M>](<link>). So I'm closing this
pull request: its change is on `main`.

<What was built differently, and why, when it was.>

The review found <N> small things, fixed in [<short hash>](<commit link>):

- <What was wrong, and what it does now.>
- <A page that still described the old behavior.>

<What was added on top, such as a test of a path the change touches.>
```

**Shipped as their own commits, merged:**

```markdown
Thanks for this! It's merged as your commit through #<M> and ships in v<version>. On top of it:

- <A review finding, fixed, with the test's numbers.>
- <Tests outside the files you touched that expected the old value; they now expect the new one.>
- <Your changelog line moved into v<version>'s section.>

<What from the pull request waits for a later version, and which.>
```

With nothing changed on top, say so: "Nothing changed on top of it, except that its changelog line
moved into v<version>'s section, with a link back here."

**Held:**

```markdown
Thanks. This waits on <what, named>: <one sentence on why the wait is needed>. <What happens to
the pull request after that, and who does it.>
```

**Taken in part:** say which part shipped and where, then which part did not, the reason, and the
issue or plan that tracks it.

**Declined:**

```markdown
Thank you for the work on this. We're not taking it: <the reason, in the project's terms>.

<What would change the answer, if anything. Another way to get the same result: a plugin, a
setting, a fork, an issue to discuss the need.>
```

Decline the change, never the person. Give the real reason. A vague one invites the same pull
request again.

### What every comment keeps

- No `@` mention. Write a login without the `@`.
- No bare `#N` unless it is a real issue or pull request on this host.
- No private host, machine or path, and nothing about a deployment's weak points.
- No promise of a date.
- The project's own rule on marking text an agent wrote. Follow its instructions.

## 4. The linked issue

An issue the pull request fixes gets a comment of its own: what is fixed, in which version, from
whose pull request, and how to use it. The issue stays open while it holds other items. Say which.

## 5. Post, only on the owner's yes

Show the owner the exact text of each comment and say what will be closed. Then wait.

After a yes for this pull request:

```sh
gh pr comment <N> --body-file <the draft>
gh pr close <N>        # only when the project shipped its own implementation, or declined
gh issue comment <I> --body-file <the draft>
```

- **Merged commits** need no close. The host marked the pull request merged.
- **A held pull request** stays open.
- **Read it back** after posting: the comment is there, the state is what was intended.

Without a yes, hand the owner the drafts and the commands. That is a finished `respond`.
