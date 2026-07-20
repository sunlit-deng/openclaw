import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LEGACY_ACCOUNT = Object.freeze({
  profile: "legacy",
  username: "sunlit-deng",
  email: "yang.jiajun1@xydigit.com",
  login: "sunlit-deng",
  pushRemote: "sunlit",
  token: "",
  configured: false,
});

function readJsonIfPresent(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function accountConfigPath(root = "") {
  if (process.env.OPENCLAW_ACCOUNTS_FILE) return path.resolve(process.env.OPENCLAW_ACCOUNTS_FILE);
  if (process.env.AUTO_PR_OPENCLAW_ACCOUNTS_FILE) return path.resolve(process.env.AUTO_PR_OPENCLAW_ACCOUNTS_FILE);
  const rootPath = root ? path.resolve(root) : "";
  if (rootPath) {
    const rootConfig = path.join(rootPath, "accounts.json");
    if (fs.existsSync(rootConfig)) return rootConfig;
  }
  return path.join(os.homedir(), ".config", "auto-pr", "openclaw-accounts.json");
}

export function loadAccountConfig(root = "") {
  const file = accountConfigPath(root);
  const config = readJsonIfPresent(file) ?? {};
  return { file, config };
}

export function findAccountProfileByLogin(login, root = "") {
  if (!login) return null;
  const { file, config } = loadAccountConfig(root);
  const profiles = config.profiles ?? {};
  const match = Object.entries(profiles).find(([, profile]) => {
    const candidateLogin = profile.login || profile.username || profile.name;
    return candidateLogin?.toLowerCase() === login.toLowerCase();
  });
  if (!match) return null;
  return {
    profile: match[0],
    configPath: file,
  };
}

function tokenForProfile(profileName, profile) {
  if (profile.tokenEnv) {
    const token = process.env[profile.tokenEnv];
    if (!token) {
      throw new Error(`GitHub account profile ${profileName} requires env ${profile.tokenEnv}`);
    }
    return token;
  }
  return profile.githubToken || profile.token || "";
}

export function resolveAccount({ workflow = {}, profile = "", root = "" } = {}) {
  const workflowRoot = root || workflow.root || "";
  const { file, config } = loadAccountConfig(workflowRoot);
  const profiles = config.profiles ?? {};
  const selected = profile
    || process.env.OPENCLAW_ACCOUNT_PROFILE
    || workflow.githubAccountProfile
    || workflow.accountProfile
    || config.defaultProfile
    || "";

  if (!selected) return { ...LEGACY_ACCOUNT, configPath: file };
  const candidate = profiles[selected];
  if (!candidate) {
    throw new Error(`GitHub account profile ${selected} was not found in ${file}`);
  }
  const username = candidate.username || candidate.name || candidate.login;
  const email = candidate.email;
  if (!username || !email) {
    throw new Error(`GitHub account profile ${selected} must define username and email`);
  }
  return {
    profile: selected,
    username,
    email,
    login: candidate.login || username,
    pushRemote: candidate.pushRemote || selected,
    token: tokenForProfile(selected, candidate),
    configured: true,
    configPath: file,
  };
}

export function resolveAccountForLogin({ login = "", workflow = {}, profile = "", root = "" } = {}) {
  const workflowRoot = root || workflow.root || "";
  if (profile || workflow.githubAccountProfile || workflow.accountProfile || process.env.OPENCLAW_ACCOUNT_PROFILE) {
    return {
      account: resolveAccount({ workflow, profile, root }),
      selection: profile ? "explicit" : workflow.githubAccountProfile || workflow.accountProfile ? "workflow" : "environment",
    };
  }
  const match = findAccountProfileByLogin(login, workflowRoot);
  if (match) {
    return {
      account: resolveAccount({ workflow, profile: match.profile, root }),
      selection: "pr-head-owner",
    };
  }
  return {
    account: resolveAccount({ workflow, root }),
    selection: "default",
  };
}

export function ghEnv(account, baseEnv = process.env) {
  if (!account?.token) return baseEnv;
  return {
    ...baseEnv,
    GH_TOKEN: account.token,
    GITHUB_TOKEN: account.token,
  };
}

export function publicAccount(account) {
  return {
    profile: account.profile,
    username: account.username,
    email: account.email,
    login: account.login,
    pushRemote: account.pushRemote,
    configured: account.configured,
    configPath: account.configPath,
    tokenSource: account.token ? "configured" : "gh-auth",
  };
}

export function commitIdentityProblems(identities, account) {
  const problems = [];
  for (const identity of identities) {
    const sha = identity.sha ?? "unknown";
    if (account.configured) {
      if (identity.authorName !== account.username || identity.authorEmail !== account.email) {
        problems.push(`${sha}: author is ${identity.authorName} <${identity.authorEmail}>; expected ${account.username} <${account.email}>`);
      }
      if (identity.committerName !== account.username || identity.committerEmail !== account.email) {
        problems.push(`${sha}: committer is ${identity.committerName} <${identity.committerEmail}>; expected ${account.username} <${account.email}>`);
      }
    } else {
      if (identity.authorName === LEGACY_ACCOUNT.username && identity.authorEmail !== LEGACY_ACCOUNT.email) {
        problems.push(`${sha}: author email is ${identity.authorEmail}`);
      }
      if (identity.committerName === LEGACY_ACCOUNT.username && identity.committerEmail !== LEGACY_ACCOUNT.email) {
        problems.push(`${sha}: committer email is ${identity.committerEmail}`);
      }
    }
  }
  return problems;
}

export function identityCheckName(account) {
  return account.configured
    ? `${account.profile} commit identity`
    : `${LEGACY_ACCOUNT.username} commit identity`;
}
