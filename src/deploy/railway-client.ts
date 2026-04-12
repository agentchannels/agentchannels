/**
 * Railway GraphQL API client.
 * Wraps Railway's public API for project creation, variable management, and deployments.
 */

const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

export interface RailwayClientConfig {
  token: string;
}

export interface RailwayProject {
  id: string;
  name: string;
  environments: { edges: Array<{ node: { id: string; name: string } }> };
  services: { edges: Array<{ node: { id: string; name: string } }> };
}

export interface RailwayDeployment {
  id: string;
  status: string;
  url?: string;
  staticUrl?: string;
}

export class RailwayClient {
  private token: string;

  constructor(config: RailwayClientConfig) {
    this.token = config.token;
  }

  /** Verify the token works by fetching user info */
  async whoami(): Promise<{ name: string; email: string }> {
    const result = await this.query<{ me: { name: string; email: string } }>(
      `query { me { name email } }`,
    );
    return result.me;
  }

  /** Create a new project */
  async createProject(name: string): Promise<RailwayProject> {
    const result = await this.query<{ projectCreate: RailwayProject }>(
      `mutation($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          id
          name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }`,
      { input: { name } },
    );
    return result.projectCreate;
  }

  /** Get a project by ID */
  async getProject(id: string): Promise<RailwayProject> {
    const result = await this.query<{ project: RailwayProject }>(
      `query($id: String!) {
        project(id: $id) {
          id
          name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }`,
      { id },
    );
    return result.project;
  }

  /** Create a service in a project */
  async createService(projectId: string, name: string): Promise<{ id: string; name: string }> {
    const result = await this.query<{ serviceCreate: { id: string; name: string } }>(
      `mutation($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }`,
      { input: { projectId, name } },
    );
    return result.serviceCreate;
  }

  /** Set multiple environment variables at once */
  async setVariables(
    projectId: string,
    environmentId: string,
    serviceId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    await this.query(
      `mutation($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`,
      {
        input: {
          projectId,
          environmentId,
          serviceId,
          variables,
        },
      },
    );
  }

  /** Connect a GitHub repo to a service for deployment */
  async connectRepo(
    serviceId: string,
    repo: string,
    branch: string = "main",
  ): Promise<void> {
    await this.query(
      `mutation($serviceId: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $serviceId, input: $input) { id }
      }`,
      {
        serviceId,
        input: { repo, branch },
      },
    );
  }

  /** Trigger a deploy */
  async triggerDeploy(
    projectId: string,
    environmentId: string,
    serviceId: string,
  ): Promise<void> {
    await this.query(
      `mutation($input: EnvironmentTriggersDeployInput!) {
        environmentTriggersDeploy(input: $input)
      }`,
      {
        input: { projectId, environmentId, serviceId },
      },
    );
  }

  /** Get the latest deployment for a service */
  async getLatestDeployment(
    projectId: string,
    serviceId: string,
    environmentId: string,
  ): Promise<RailwayDeployment | undefined> {
    const result = await this.query<{
      deployments: { edges: Array<{ node: RailwayDeployment }> };
    }>(
      `query($input: DeploymentListInput!) {
        deployments(input: $input, first: 1) {
          edges { node { id status url staticUrl } }
        }
      }`,
      {
        input: { projectId, serviceId, environmentId },
      },
    );
    return result.deployments.edges[0]?.node;
  }

  /** Generate a public domain for a service */
  async createDomain(
    serviceId: string,
    environmentId: string,
  ): Promise<{ domain: string }> {
    const result = await this.query<{
      serviceDomainCreate: { domain: string };
    }>(
      `mutation($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { domain }
      }`,
      {
        input: { serviceId, environmentId },
      },
    );
    return result.serviceDomainCreate;
  }

  /** Low-level GraphQL query */
  private async query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(RAILWAY_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Railway API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors?.length) {
      throw new Error(`Railway API error: ${json.errors.map((e) => e.message).join(", ")}`);
    }

    return json.data as T;
  }
}
