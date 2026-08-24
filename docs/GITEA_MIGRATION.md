# Make Gitea the primary repository

The primary repository is
<https://overlord.kyun.li/vxaboveground/overlord>. These instructions preserve
all Git branches, tags, and commits reachable from them, make Gitea the default
remote for development, and configure Gitea to push-mirror to GitLab.

This runbook targets Gitea 1.27.2. It intentionally does not use
`git push --mirror` from a working clone. A working clone contains local and
remote-tracking refs that are not part of the public branch/tag contract, and a
mirror push can also delete destination refs.

## Canonical remotes

The prepared working clone has these exact remotes:

| Name | Role | Fetch and push URL |
| --- | --- | --- |
| `origin` | Primary Gitea repository and default push target | `ssh://git@overlord.kyun.li:222/vxaboveground/overlord.git` |
| `gitlab` | Former primary; retained for comparison while the Gitea push mirror is verified | `ssh://git@altssh.gitlab.com:443/vxaboveground/overlord.git` |
| `forgejo` | Legacy internal Forgejo remote | `ssh://git@10.0.22.220:22/KDOT/Overlord-Public.git` |

`main` tracks `origin/main`, and `remote.pushDefault` is `origin`. Confirm the
local setup before the cutover:

```bash
git remote -v
git config --get branch.main.remote
git config --get branch.main.merge
git config --get remote.pushDefault
```

The expected last three values are `origin`, `refs/heads/main`, and `origin`.
Do not push directly to `gitlab` after the server-side push mirror is enabled;
Gitea must be the sole write authority.

## Copy Git history safely

1. Announce a short write freeze on GitLab. Merge or close outstanding work and
   wait for running pushes to finish. Commit the migration-preparation files in
   this checkout and push that commit to `gitlab/main` before taking the final
   bare clone, so the new Gitea workflows and canonical links are included in
   the copied history.
2. Back up the GitLab project. Create the Gitea repository at the primary URL
   as an **empty** repository: do not initialize a README, license, or
   `.gitignore` in Gitea.
3. From a temporary directory outside this working clone, make a bare clone of
   GitLab and inspect it:

   ```bash
   migration_dir="$(mktemp -d)"
   git clone --bare \
     ssh://git@altssh.gitlab.com:443/vxaboveground/overlord.git \
     "$migration_dir/overlord.git"
   git -C "$migration_dir/overlord.git" fsck --full
   git -C "$migration_dir/overlord.git" for-each-ref \
     --format='%(objectname) %(refname)' refs/heads refs/tags
   ```

4. Add Gitea only to that bare migration clone, then push explicit branch and
   tag namespaces. These refspecs do not include remote-tracking, CI, merge
   request, or other implementation-specific refs, and they do not request
   deletion of destination refs:

   ```bash
   git -C "$migration_dir/overlord.git" remote add gitea \
     ssh://git@overlord.kyun.li:222/vxaboveground/overlord.git
   git -C "$migration_dir/overlord.git" push --atomic gitea \
     'refs/heads/*:refs/heads/*' \
     'refs/tags/*:refs/tags/*'
   ```

   A non-fast-forward rejection means Gitea already contains divergent work.
   Stop and reconcile that work; do not add `--force` just to make the command
   pass.

5. Compare the source and destination refs exactly:

   ```bash
   git ls-remote --heads \
     ssh://git@altssh.gitlab.com:443/vxaboveground/overlord.git \
     | sort > "$migration_dir/gitlab-heads"
   git ls-remote --heads \
     ssh://git@overlord.kyun.li:222/vxaboveground/overlord.git \
     | sort > "$migration_dir/gitea-heads"
   git ls-remote --tags \
     ssh://git@altssh.gitlab.com:443/vxaboveground/overlord.git \
     | sort > "$migration_dir/gitlab-tags"
   git ls-remote --tags \
     ssh://git@overlord.kyun.li:222/vxaboveground/overlord.git \
     | sort > "$migration_dir/gitea-tags"
   diff -u "$migration_dir/gitlab-heads" "$migration_dir/gitea-heads"
   diff -u "$migration_dir/gitlab-tags" "$migration_dir/gitea-tags"
   ```

   Both `diff` commands should produce no output. In Gitea, set `main` as the
   default branch and recreate branch/tag protection, collaborators, deploy
   keys, webhooks, Actions secrets, and other host-level settings.

The explicit Git copy does not migrate GitLab issues, merge requests, comments,
release records, CI variables, job artifacts, package/container registries, or
other GitLab database content. Export/import those separately if they must be
retained. If Git LFS is enabled later, its objects also require an explicit LFS
fetch/push; ordinary ref pushes do not transfer LFS object content.

## Make Gitea the default in other clones

For an existing clone that still calls GitLab `origin`, preserve that remote
under the `gitlab` name and add Gitea as the new `origin`:

```bash
git remote rename origin gitlab
git remote add origin \
  ssh://git@overlord.kyun.li:222/vxaboveground/overlord.git
git fetch origin --prune --tags
git branch --set-upstream-to=origin/main main
git config remote.pushDefault origin
```

If that clone already has a remote called `gitlab`, update URLs instead of
renaming over it:

```bash
git remote set-url origin \
  ssh://git@overlord.kyun.li:222/vxaboveground/overlord.git
git remote set-url gitlab \
  ssh://git@altssh.gitlab.com:443/vxaboveground/overlord.git
git fetch origin --prune --tags
git branch --set-upstream-to=origin/main main
git config remote.pushDefault origin
```

Test the cutover with a normal branch push to `origin`. Avoid configuring a
client-side push URL that writes to both hosts: the Gitea server-side mirror is
the single replication mechanism and exposes failures in its UI.

## Configure the Gitea-to-GitLab push mirror

Gitea's push mirror force-updates the destination. Once enabled, changes made
directly on GitLab may be overwritten or deleted on the next sync. Keep the
GitLab project read-only for normal development and treat it as a replica.

1. In GitLab, create a project access token or personal access token with the
   `write_repository` scope. Use an account permitted to update the repository's
   protected branches and tags.
2. In Gitea, open **Settings > Repository > Mirror Settings** for
   `vxaboveground/overlord` and choose **Add Push Mirror**.
3. Enter these values:

   - Remote repository URL: `https://gitlab.com/vxaboveground/overlord.git`
   - Authorization username: `oauth2`
   - Authorization password: the GitLab token

4. Enable **Sync when new commits are pushed**, add the mirror, and select
   **Synchronize Now** for the initial replication.
5. Confirm that Gitea reports a successful sync, then compare heads and tags
   again with the verification commands above. Make a small test branch in
   Gitea, confirm it arrives in GitLab, and delete it from Gitea so the deletion
   behavior is also understood before ending the write freeze.

If a sync fails, inspect the error in Gitea's Mirror Settings. The usual causes
are an expired token, missing `write_repository` permission, or GitLab protected
branch/tag rules that reject the mirror account. Rotate the GitLab credential in
Gitea rather than embedding it in a Git remote URL or this repository.

GitLab CI may run when mirrored commits arrive because this repository retains
`.gitlab-ci.yml`. Keep that behavior if GitLab remains a CI replica; otherwise
disable GitLab pipelines in the GitLab project settings after confirming Gitea
Actions covers the required jobs.

## Final checks

- `origin` fetches and pushes to Gitea over SSH port 222.
- `main` tracks `origin/main`, and `remote.pushDefault` is `origin`.
- All GitLab heads and tags match Gitea at the end of the write freeze.
- The Gitea push mirror reports a successful GitLab sync.
- Branch/tag protections, access controls, secrets, and webhooks exist in Gitea.
- The repository-scoped runner is online and a Gitea Actions workflow passes.
- Developers know Gitea is authoritative and GitLab is read-only.

After an agreed observation period, remove the legacy `forgejo` remote from
developer clones if it is no longer needed. Keep backups according to the
project's retention policy.
