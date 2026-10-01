/* The little of Fly.io's Machines API the matchmaker's autoscaler needs:
   list the game server machines, start one, stop one. */

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
}

export class FlyMachines {
  constructor(private readonly app: string, private readonly token: string) {}

  private async call(method: string, path: string): Promise<unknown> {
    /* a deploy token is a macaroon ("FlyV1 fm2_..."); an older token is a
       bearer token */
    const authorization = this.token.startsWith("FlyV1 ") ? this.token : `Bearer ${this.token}`;
    const response = await fetch(`https://api.machines.dev/v1/apps/${encodeURIComponent(this.app)}${path}`, {
      method,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Fly ${method} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
  }

  async list(): Promise<FlyMachine[]> {
    const machines = await this.call("GET", "/machines") as Array<Record<string, unknown>>;
    return machines.map((machine) => ({
      id: String(machine.id),
      name: String(machine.name),
      state: String(machine.state),
    }));
  }

  async start(id: string): Promise<void> {
    await this.call("POST", `/machines/${encodeURIComponent(id)}/start`);
  }

  async stop(id: string): Promise<void> {
    await this.call("POST", `/machines/${encodeURIComponent(id)}/stop`);
  }
}
