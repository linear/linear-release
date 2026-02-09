// Stub types to be used until proper types are added to the Linear SDK
export type Release = {
  id: string;
  name: string;
  version?: string;
  commitSha?: string;
  createdAt: string;
  url?: string;
};

// Access key endpoint response types
export type AccessKeyLatestReleaseResponse = {
  data: {
    latestReleaseByAccessKey: Release | null;
  };
};

export type AccessKeyPipelineSettingsResponse = {
  data: {
    releasePipelineByAccessKey: {
      includePathPatterns: string[];
    };
  };
};

export type AccessKeySyncReleaseResponse = {
  data: {
    releaseSyncByAccessKey: {
      success: boolean;
      release: Release;
    };
  };
};

export type AccessKeyCompleteReleaseResponse = {
  data: {
    releaseCompleteByAccessKey: {
      success: boolean;
      release: {
        id: string;
        name: string;
        version?: string;
        url?: string;
      } | null;
    };
  };
};

export type AccessKeyUpdateByPipelineResponse = {
  data: {
    releaseUpdateByPipelineByAccessKey: {
      success: boolean;
      release: {
        id: string;
        name: string;
        version?: string;
        url?: string;
        stage: {
          name: string;
        } | null;
      } | null;
    };
  };
};

// Git and context specific types
export type CommitContext = {
  sha: string;
  branchName?: string | null;
  message?: string | null;
};

export type GitInfo = {
  branch: string | null;
  commit: string | null;
  message: string | null;
};

export type RepoInfo = {
  owner: string | null;
  name: string | null;
  provider: string | null;
  url: string | null;
};

export type FoundIssueIdentifier = {
  identifier: string;
  commitSha: string;
  source: "commit_message" | "branch_name";
};

// Debug sink types
export type IssueSource = {
  sha: string;
  source: "branch_name" | "commit_message";
  value: string; // The actual branch name or commit message
};

export type PullRequestSource = {
  sha: string;
  number: number;
  value: string; // The commit message containing the PR reference
};

export type DebugSink = {
  inspectedShas: string[]; // From oldest to newest
  issues: Record<string, IssueSource[]>; // Issue identifier -> array of sources
  pullRequests: PullRequestSource[]; // PR numbers found in commits
  includePaths: string[] | null; // Path filters applied during commit scanning
};
