// Connected observability sources shown in the console sidebar.
//
// For this scaffold the source list is static, preconfigured demo config
// (mirroring the design prototype): the first slice has preconfigured GitHub,
// Datadog, and TrueFoundry integrations for one workspace and one repository,
// with no self-serve connect/disconnect flow (PRD SEC-3, "Out of scope: No
// OAuth setup flow"). Later tasks back integration health with server data.

export interface Source {
  id: string;
  name: string;
  abbr: string;
  color: string;
  connected: boolean;
}

export const SOURCES: Source[] = [
  { id: 'datadog', name: 'Datadog', abbr: 'DD', color: '#632CA6', connected: true },
  { id: 'github', name: 'GitHub', abbr: 'GH', color: '#1B1F24', connected: true },
  { id: 'truefoundry', name: 'TrueFoundry', abbr: 'TF', color: '#5B3DF5', connected: true },
];
