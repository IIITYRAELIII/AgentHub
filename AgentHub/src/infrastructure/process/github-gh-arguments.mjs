// Value-consuming option roles from GitHub CLI 2.96.0 `gh help reference`.
// Reference SHA256: 95ee5d73dfab28405d8f134b5747ef2337f07ab3d0b3eed112325e5f48f095d2
// Actual parser proof SHA256: fd624d7e39d4660f0ef8f7a7190f725b19a0a4afa8b38326c9535641a26ba232
// Help identifies names only; actual NoOptDefVal/argument consumption determines arity.
// This is source grammar metadata, not a runtime query/cache or a command allowlist.
const valuedOptions = {
  "agent-task": "",
  "agent-task create": "--base --custom-agent --from-file -F=--from-file -a=--custom-agent -b=--base",
  "agent-task list": "--jq --json --limit --template -L=--limit -q=--jq -t=--template",
  "agent-task view": "--jq --json --template -q=--jq -t=--template",
  "alias": "",
  "alias delete": "",
  "alias import": "",
  "alias list": "",
  "alias set": "",
  "api": "--cache --field --header --hostname --input --jq --method --preview --raw-field --template -F=--field -H=--header -X=--method -f=--raw-field -p=--preview -q=--jq -t=--template",
  "attestation": "",
  "attestation download": "--digest-alg --hostname --limit --owner --predicate-type --repo -L=--limit -R=--repo -d=--digest-alg -o=--owner",
  "attestation trusted-root": "--hostname --tuf-root --tuf-url",
  "attestation verify": "--bundle --cert-identity --cert-identity-regex --cert-oidc-issuer --custom-trusted-root --digest-alg --format --hostname --jq --limit --owner --predicate-type --repo --signer-digest --signer-repo --signer-workflow --source-digest --source-ref --template -L=--limit -R=--repo -b=--bundle -d=--digest-alg -i=--cert-identity-regex -o=--owner -q=--jq -t=--template",
  "auth": "",
  "auth login": "--git-protocol --hostname --scopes -h=--hostname -p=--git-protocol -s=--scopes",
  "auth logout": "--hostname --user -h=--hostname -u=--user",
  "auth refresh": "--hostname --remove-scopes --scopes -h=--hostname -r=--remove-scopes -s=--scopes",
  "auth setup-git": "--hostname -h=--hostname",
  "auth status": "--hostname --jq --json --template -h=--hostname",
  "auth switch": "--hostname --user -h=--hostname -u=--user",
  "auth token": "--hostname --user -h=--hostname -u=--user",
  "browse": "--branch -b=--branch",
  "cache": "",
  "cache delete": "--ref -r=--ref",
  "cache list": "--jq --json --key --limit --order --ref --sort --template -L=--limit -O=--order -S=--sort -k=--key -q=--jq -r=--ref -t=--template",
  "co": "",
  "codespace": "",
  "codespace code": "--codespace --repo --repo-owner -R=--repo -c=--codespace",
  "codespace cp": "--codespace --profile --repo --repo-owner -R=--repo -c=--codespace -p=--profile",
  "codespace create": "--branch --devcontainer-path --display-name --idle-timeout --location --machine --repo --retention-period -R=--repo -b=--branch -d=--display-name -l=--location -m=--machine",
  "codespace delete": "--codespace --days --org --repo --repo-owner --user -R=--repo -c=--codespace -o=--org -u=--user",
  "codespace edit": "--codespace --display-name --machine --repo --repo-owner -R=--repo -c=--codespace -d=--display-name -m=--machine",
  "codespace jupyter": "--codespace --repo --repo-owner -R=--repo -c=--codespace",
  "codespace list": "--jq --json --limit --org --repo --template --user -L=--limit -R=--repo -o=--org -q=--jq -t=--template -u=--user",
  "codespace logs": "--codespace --repo --repo-owner -R=--repo -c=--codespace",
  "codespace ports": "--codespace --jq --json --repo --repo-owner --template -R=--repo -c=--codespace -q=--jq -t=--template",
  "codespace ports forward": "",
  "codespace ports visibility": "",
  "codespace rebuild": "--codespace --repo --repo-owner -R=--repo -c=--codespace",
  "codespace ssh": "--codespace --debug-file --profile --repo --repo-owner --server-port -R=--repo -c=--codespace",
  "codespace stop": "--codespace --org --repo --repo-owner --user -R=--repo -c=--codespace -o=--org -u=--user",
  "codespace view": "--codespace --jq --json --repo --repo-owner --template -R=--repo -c=--codespace -q=--jq -t=--template",
  "completion": "--shell -s=--shell",
  "config": "",
  "config clear-cache": "",
  "config get": "--host -h=--host",
  "config list": "--host -h=--host",
  "config set": "--host -h=--host",
  "copilot": "",
  "discussion": "",
  "discussion comment": "--body --body-file -F=--body-file -b=--body",
  "discussion create": "--body --body-file --category --label --title -F=--body-file -b=--body -c=--category -l=--label -t=--title",
  "discussion edit": "--add-label --body --body-file --category --remove-label --title -F=--body-file -b=--body -c=--category -t=--title",
  "discussion list": "--after --author --category --jq --json --label --limit --order --search --sort --state --template -A=--author -L=--limit -S=--search -c=--category -l=--label -q=--jq -s=--state -t=--template",
  "discussion view": "--after --jq --json --limit --order --template -L=--limit -q=--jq -t=--template",
  "extension": "",
  "extension browse": "",
  "extension create": "--precompiled",
  "extension exec": "",
  "extension install": "--pin",
  "extension list": "",
  "extension remove": "",
  "extension search": "--jq --json --license --limit --order --owner --sort --template -L=--limit -q=--jq -t=--template",
  "extension upgrade": "",
  "gist": "",
  "gist clone": "",
  "gist create": "--desc --filename -d=--desc -f=--filename",
  "gist delete": "",
  "gist edit": "--add --desc --filename --remove -a=--add -d=--desc -f=--filename -r=--remove",
  "gist list": "--filter --limit -L=--limit",
  "gist rename": "",
  "gist view": "--filename -f=--filename",
  "gpg-key": "",
  "gpg-key add": "--title -t=--title",
  "gpg-key delete": "",
  "gpg-key list": "",
  "issue": "",
  "issue close": "--comment --duplicate-of --reason -c=--comment -r=--reason",
  "issue comment": "--body --body-file -F=--body-file -b=--body",
  "issue create": "--assignee --blocked-by --blocking --body --body-file --label --milestone --parent --project --recover --template --title --type -F=--body-file -T=--template -a=--assignee -b=--body -l=--label -m=--milestone -p=--project -t=--title",
  "issue delete": "",
  "issue develop": "--base --branch-repo --name -b=--base -n=--name",
  "issue edit": "--add-assignee --add-blocked-by --add-blocking --add-label --add-project --add-sub-issue --body --body-file --milestone --parent --remove-assignee --remove-blocked-by --remove-blocking --remove-label --remove-project --remove-sub-issue --title --type -F=--body-file -b=--body -m=--milestone -t=--title",
  "issue list": "--app --assignee --author --jq --json --label --limit --mention --milestone --search --state --template --type -A=--author -L=--limit -S=--search -a=--assignee -l=--label -m=--milestone -q=--jq -s=--state -t=--template",
  "issue lock": "--reason -r=--reason",
  "issue pin": "",
  "issue reopen": "--comment -c=--comment",
  "issue status": "--jq --json --template -q=--jq -t=--template",
  "issue transfer": "",
  "issue unlock": "",
  "issue unpin": "",
  "issue view": "--jq --json --template -q=--jq -t=--template",
  "label": "",
  "label clone": "",
  "label create": "--color --description -c=--color -d=--description",
  "label delete": "",
  "label edit": "--color --description --name -c=--color -d=--description -n=--name",
  "label list": "--jq --json --limit --order --search --sort --template -L=--limit -S=--search -q=--jq -t=--template",
  "licenses": "",
  "org": "",
  "org list": "--limit -L=--limit",
  "pr": "--repo -R=--repo",
  "pr checkout": "--branch -b=--branch",
  "pr checks": "--interval --jq --json --template -i=--interval -q=--jq -t=--template",
  "pr close": "--comment -c=--comment",
  "pr comment": "--body --body-file -F=--body-file -b=--body",
  "pr create": "--assignee --base --body --body-file --head --label --milestone --project --recover --reviewer --template --title -B=--base -F=--body-file -H=--head -T=--template -a=--assignee -b=--body -l=--label -m=--milestone -p=--project -r=--reviewer -t=--title",
  "pr diff": "--color --exclude -e=--exclude",
  "pr edit": "--add-assignee --add-label --add-project --add-reviewer --base --body --body-file --milestone --remove-assignee --remove-label --remove-project --remove-reviewer --title -B=--base -F=--body-file -b=--body -m=--milestone -t=--title",
  "pr list": "--app --assignee --author --base --head --jq --json --label --limit --search --state --template -A=--author -B=--base -H=--head -L=--limit -S=--search -a=--assignee -l=--label -q=--jq -s=--state -t=--template",
  "pr lock": "--reason -r=--reason",
  "pr merge": "--author-email --body --body-file --match-head-commit --subject -A=--author-email -F=--body-file -b=--body -t=--subject",
  "pr ready": "",
  "pr reopen": "--comment -c=--comment",
  "pr revert": "--body --body-file --title -F=--body-file -b=--body -t=--title",
  "pr review": "--body --body-file -F=--body-file -b=--body",
  "pr status": "--jq --json --template -q=--jq -t=--template",
  "pr unlock": "",
  "pr update-branch": "",
  "pr view": "--jq --json --template -q=--jq -t=--template",
  "preview": "",
  "preview prompter": "",
  "project": "",
  "project close": "--format --jq --owner --template -q=--jq -t=--template",
  "project copy": "--format --jq --source-owner --target-owner --template --title -q=--jq -t=--template",
  "project create": "--format --jq --owner --template --title -q=--jq -t=--template",
  "project delete": "--format --jq --owner --template -q=--jq -t=--template",
  "project edit": "--description --format --jq --owner --readme --template --title --visibility -d=--description -q=--jq -t=--template",
  "project field-create": "--data-type --format --jq --name --owner --single-select-options --template -q=--jq -t=--template",
  "project field-delete": "--format --id --jq --template -q=--jq -t=--template",
  "project field-list": "--format --jq --limit --owner --template -L=--limit -q=--jq -t=--template",
  "project item-add": "--format --jq --owner --template --url -q=--jq -t=--template",
  "project item-archive": "--format --id --jq --owner --template -q=--jq -t=--template",
  "project item-create": "--body --format --jq --owner --template --title -q=--jq -t=--template",
  "project item-delete": "--format --id --jq --owner --template -q=--jq -t=--template",
  "project item-edit": "--body --date --field-id --format --id --iteration-id --jq --number --project-id --single-select-option-id --template --text --title -q=--jq -t=--template",
  "project item-list": "--format --jq --limit --owner --query --template -L=--limit -q=--jq -t=--template",
  "project link": "--owner --repo --team -R=--repo -T=--team",
  "project list": "--format --jq --limit --owner --template -L=--limit -q=--jq -t=--template",
  "project mark-template": "--format --jq --owner --template -q=--jq -t=--template",
  "project unlink": "--owner --repo --team -R=--repo -T=--team",
  "project view": "--format --jq --owner --template -q=--jq -t=--template",
  "release": "",
  "release create": "--discussion-category --notes --notes-file --notes-start-tag --target --title -F=--notes-file -n=--notes -t=--title",
  "release delete": "",
  "release delete-asset": "",
  "release download": "--archive --dir --output --pattern -A=--archive -D=--dir -O=--output -p=--pattern",
  "release edit": "--discussion-category --notes --notes-file --tag --target --title -F=--notes-file -n=--notes -t=--title",
  "release list": "--jq --json --limit --order --template -L=--limit -O=--order -q=--jq -t=--template",
  "release upload": "",
  "release verify": "--format --jq --template -q=--jq -t=--template",
  "release verify-asset": "--format --jq --template -q=--jq -t=--template",
  "release view": "--jq --json --template -q=--jq -t=--template",
  "repo": "",
  "repo archive": "",
  "repo autolink": "",
  "repo autolink create": "",
  "repo autolink delete": "",
  "repo autolink list": "--jq --json --template -q=--jq -t=--template",
  "repo autolink view": "--jq --json --template -q=--jq -t=--template",
  "repo clone": "--upstream-remote-name -u=--upstream-remote-name",
  "repo create": "--description --gitignore --homepage --license --remote --source --team --template -d=--description -g=--gitignore -h=--homepage -l=--license -p=--template -r=--remote -s=--source -t=--team",
  "repo delete": "",
  "repo deploy-key": "",
  "repo deploy-key add": "--title -t=--title",
  "repo deploy-key delete": "",
  "repo deploy-key list": "--jq --json --template -q=--jq -t=--template",
  "repo edit": "--add-topic --default-branch --description --homepage --remove-topic --squash-merge-commit-message --visibility -d=--description -h=--homepage",
  "repo fork": "--fork-name --org --remote-name",
  "repo gitignore": "",
  "repo gitignore list": "",
  "repo gitignore view": "",
  "repo license": "",
  "repo license list": "",
  "repo license view": "",
  "repo list": "--jq --json --language --limit --template --topic --visibility -L=--limit -l=--language -q=--jq -t=--template",
  "repo read-dir": "--jq --json --ref --template -q=--jq -t=--template",
  "repo read-file": "--jq --json --output --ref --template -o=--output -q=--jq -t=--template",
  "repo rename": "",
  "repo set-default": "",
  "repo sync": "--branch --source -b=--branch -s=--source",
  "repo unarchive": "",
  "repo view": "--branch --jq --json --template -b=--branch -q=--jq -t=--template",
  "ruleset": "",
  "ruleset check": "",
  "ruleset list": "--limit --org -L=--limit -o=--org",
  "ruleset view": "--org -o=--org",
  "run": "",
  "run cancel": "",
  "run delete": "",
  "run download": "--dir --name --pattern -D=--dir -n=--name -p=--pattern",
  "run list": "--branch --commit --created --event --jq --json --limit --status --template --user --workflow -L=--limit -b=--branch -c=--commit -e=--event -q=--jq -s=--status -t=--template -u=--user -w=--workflow",
  "run rerun": "--job -j=--job",
  "run view": "--attempt --job --jq --json --template -a=--attempt -j=--job -q=--jq -t=--template",
  "run watch": "--interval -i=--interval",
  "search": "",
  "search code": "--extension --filename --jq --json --language --limit --match --owner --repo --size --template -L=--limit -R=--repo -q=--jq -t=--template",
  "search commits": "--author --author-date --author-email --author-name --committer --committer-date --committer-email --committer-name --hash --jq --json --limit --order --owner --parent --repo --sort --template --tree --visibility -L=--limit -R=--repo -q=--jq -t=--template",
  "search issues": "--app --assignee --author --closed --commenter --comments --created --interactions --involves --jq --json --label --language --limit --match --mentions --milestone --order --owner --project --reactions --repo --sort --state --team-mentions --template --updated --visibility -L=--limit -R=--repo -q=--jq -t=--template",
  "search prs": "--app --assignee --author --base --checks --closed --commenter --comments --created --head --interactions --involves --jq --json --label --language --limit --match --mentions --merged-at --milestone --order --owner --project --reactions --repo --review --review-requested --reviewed-by --sort --state --team-mentions --template --updated --visibility -B=--base -H=--head -L=--limit -R=--repo -q=--jq -t=--template",
  "search repos": "--created --followers --forks --good-first-issues --help-wanted-issues --include-forks --jq --json --language --license --limit --match --number-topics --order --owner --size --sort --stars --template --topic --updated --visibility -L=--limit -q=--jq -t=--template",
  "secret": "",
  "secret delete": "--app --env --org -a=--app -e=--env -o=--org",
  "secret list": "--app --env --jq --json --org --template -a=--app -e=--env -o=--org -q=--jq -t=--template",
  "secret set": "--app --body --env --env-file --org --repos --visibility -a=--app -b=--body -e=--env -f=--env-file -o=--org -r=--repos -v=--visibility",
  "skill": "",
  "skill install": "--agent --dir --pin --scope",
  "skill list": "--agent --dir --jq --json --scope --template -q=--jq -t=--template",
  "skill preview": "",
  "skill publish": "--tag",
  "skill search": "--jq --json --limit --owner --page --template -L=--limit -q=--jq -t=--template",
  "skill update": "--dir",
  "ssh-key": "",
  "ssh-key add": "--title --type -t=--title",
  "ssh-key delete": "",
  "ssh-key list": "",
  "status": "--exclude --org -e=--exclude -o=--org",
  "variable": "",
  "variable delete": "--env --org -e=--env -o=--org",
  "variable get": "--env --jq --json --org --template -e=--env -o=--org -q=--jq -t=--template",
  "variable list": "--env --jq --json --org --template -e=--env -o=--org -q=--jq -t=--template",
  "variable set": "--body --env --env-file --org --repos --visibility -b=--body -e=--env -f=--env-file -o=--org -r=--repos -v=--visibility",
  "workflow": "",
  "workflow disable": "",
  "workflow enable": "",
  "workflow list": "--jq --json --limit --template -L=--limit -q=--jq -t=--template",
  "workflow run": "--field --raw-field --ref -F=--field -f=--raw-field -r=--ref",
  "workflow view": "--ref -r=--ref",
};
const aliases = {
  "agent-tasks": "agent-task",
  "agent": "agent-task",
  "agents": "agent-task",
  "alias ls": "alias list",
  "at": "attestation",
  "cache ls": "cache list",
  "cs": "codespace",
  "codespace ls": "codespace list",
  "cs ls": "codespace list",
  "config ls": "config list",
  "discussion ls": "discussion list",
  "extensions": "extension",
  "ext": "extension",
  "ext ls": "extension list",
  "extension ls": "extension list",
  "extensions ls": "extension list",
  "ext uninstall": "extension remove",
  "extension uninstall": "extension remove",
  "extensions uninstall": "extension remove",
  "gist new": "gist create",
  "gist ls": "gist list",
  "gpg-key ls": "gpg-key list",
  "issue new": "issue create",
  "issue ls": "issue list",
  "label ls": "label list",
  "org ls": "org list",
  "pr co": "pr checkout",
  "pr new": "pr create",
  "pr ls": "pr list",
  "project ls": "project list",
  "release new": "release create",
  "release ls": "release list",
  "repo autolink new": "repo autolink create",
  "repo autolink ls": "repo autolink list",
  "repo new": "repo create",
  "repo deploy-key ls": "repo deploy-key list",
  "repo gitignore ls": "repo gitignore list",
  "repo license ls": "repo license list",
  "repo ls": "repo list",
  "rs": "ruleset",
  "rs ls": "ruleset list",
  "ruleset ls": "ruleset list",
  "run ls": "run list",
  "secret remove": "secret delete",
  "secret ls": "secret list",
  "skills": "skill",
  "skill add": "skill install",
  "skills add": "skill install",
  "skill ls": "skill list",
  "skills ls": "skill list",
  "skill show": "skill preview",
  "skills show": "skill preview",
  "ssh-key ls": "ssh-key list",
  "variable remove": "variable delete",
  "variable ls": "variable list",
  "workflow ls": "workflow list"
};

const definitions = new Map(Object.entries(valuedOptions).map(([command, spec]) =>
  [command, new Map(spec.split(" ").filter(Boolean).map(option => {
    const [flag, canonical = flag] = option.split("=");
    return [flag, canonical];
  }))]));
const aliasNames = Object.keys(aliases).sort((a, b) => b.length - a.length);
const canonicalCommand = words => {
  const command = words.join(" ");
  const alias = aliasNames.find(name => command === name || command.startsWith(name + " "));
  return alias ? aliases[alias] + command.slice(alias.length) : command;
};
const prefixes = new Set([...definitions.keys()].flatMap(command => {
  const words = command.split(" ");
  return words.map((_, index) => words.slice(0, index + 1).join(" "));
}));

export function githubInvocation(args) {
  const words = [], operands = [], values = new Map();
  let hostname, repository;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") { operands.push(...args.slice(index + 1)); break; }
    if (!argument.startsWith("-") || argument === "-") {
      if (!operands.length && prefixes.has(canonicalCommand([...words, argument]))) words.push(argument);
      else operands.push(argument);
      continue;
    }
    const command = canonicalCommand(words).split(" ");
    const options = new Map(command.flatMap((_, depth) =>
      [...(definitions.get(command.slice(0, depth + 1).join(" ")) ?? [])]));
    const record = (flag, value) => {
      if (!values.has(flag)) values.set(flag, []);
      values.get(flag).push(value ?? "");
      if (flag === "--hostname") hostname = value ?? "";
      if (flag === "--repo") repository = value ?? "";
    };
    if (argument.startsWith("--")) {
      const equal = argument.indexOf("="), flag = equal < 0 ? argument : argument.slice(0, equal);
      const role = flag === "--repo" || flag === "--hostname" ? flag : options.get(flag);
      if (role) record(role, equal < 0 ? args[++index] : argument.slice(equal + 1));
    } else {
      // pflag shorthands may be clustered; a valued one owns the remaining
      // characters (or the next argv), including literal flag-shaped content.
      for (let offset = 1; offset < argument.length; offset++) {
        const flag = "-" + argument[offset], role = flag === "-R" ? "--repo" : options.get(flag);
        if (!role) {
          // Even a boolean/NoOpt shorthand owns an explicit =value. Its
          // contents are never interpreted as more clustered flags.
          if (argument[offset + 1] === "=") break;
          continue;
        }
        let value = argument.slice(offset + 1);
        const attached = value.length > 0;
        if (value.startsWith("=")) value = value.slice(1);
        if (!attached) value = args[++index];
        record(role, value);
        break;
      }
    }
  }
  return { command: canonicalCommand(words).split(" ").filter(Boolean), operands, hostname, repository, values };
}
