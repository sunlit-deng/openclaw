import type { MattermostClient, MattermostPost } from "./client.js";

export async function fetchMattermostThreadPosts(
  client: MattermostClient,
  postId: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<MattermostPost[]> {
  const { limit, signal } = options;
  const query = typeof limit === "number" && limit > 0 ? `?perPage=${limit}&direction=up` : "";
  const data = await client.request<{
    order: string[];
    posts: Record<string, MattermostPost>;
  }>(`/posts/${postId}/thread${query}`, signal ? { signal } : undefined);
  const posts: MattermostPost[] = (data.order ?? [])
    .map((pid) => data.posts?.[pid])
    .filter((p): p is MattermostPost => p != null);
  return posts.toSorted((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
}
