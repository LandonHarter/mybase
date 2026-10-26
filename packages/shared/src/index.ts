export const DEFAULT_API_URL = "http://localhost:4000";

export interface Project {
  name: string;
  createdAt: string;
}

export interface CreateProjectRequest {
  name: string;
}
