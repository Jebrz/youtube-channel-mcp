import { YOUTUBE_DATA_BASE_URL } from "../config.js";
import { ApiError, YouTubeMcpError } from "../errors.js";
import type { GoogleClient } from "./client.js";

/** Subset of the YouTube Data API v3 resources this server reads. */
export interface ChannelResource {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    publishedAt?: string;
    country?: string;
    thumbnails?: Record<string, { url?: string; width?: number; height?: number }>;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string; likes?: string } };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
  };
  status?: { privacyStatus?: string; isLinked?: boolean; madeForKids?: boolean; longUploadsStatus?: string };
}

export interface PlaylistItemResource {
  id: string;
  snippet?: { title?: string; description?: string; publishedAt?: string; position?: number; channelId?: string };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  status?: { privacyStatus?: string };
}

export interface VideoResource {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url?: string; width?: number; height?: number }>;
  };
  contentDetails?: { duration?: string; definition?: string; caption?: string; licensedContent?: boolean; dimension?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string };
  status?: {
    uploadStatus?: string;
    privacyStatus?: string;
    publishAt?: string;
    license?: string;
    embeddable?: boolean;
    madeForKids?: boolean;
  };
  liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string; scheduledStartTime?: string };
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo?: { totalResults?: number; resultsPerPage?: number };
}

export class NoChannelError extends YouTubeMcpError {
  constructor() {
    super(
      "NO_CHANNEL",
      "The signed-in Google account has no YouTube channel.",
      { hint: "If your channel belongs to a Brand Account, run `auth` again and choose the brand channel on Google's account chooser." },
    );
  }
}

export class YouTubeDataApi {
  constructor(private readonly client: GoogleClient) {}

  private url(path: string, params: Record<string, string | number | boolean | undefined>): URL {
    const url = new URL(`${YOUTUBE_DATA_BASE_URL}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    return url;
  }

  /** channels.list?mine=true (quota cost: 1 unit). */
  async getMyChannel(): Promise<ChannelResource> {
    const res = await this.client.getJson<ListResponse<ChannelResource>>(
      this.url("channels", { part: "snippet,contentDetails,statistics,status", mine: true, maxResults: 1 }),
      "data",
    );
    const ch = res.items?.[0];
    if (!ch) throw new NoChannelError();
    return ch;
  }

  /**
   * One page of the channel's uploads playlist via playlistItems.list (1 unit per page).
   * Returns `undefined` items when the uploads playlist doesn't exist yet (channel with no uploads).
   */
  async listUploadsPage(
    uploadsPlaylistId: string,
    opts: { pageToken?: string; maxResults: number },
  ): Promise<{ items: PlaylistItemResource[]; nextPageToken?: string; prevPageToken?: string; totalResults?: number; playlistMissing: boolean }> {
    try {
      const res = await this.client.getJson<ListResponse<PlaylistItemResource>>(
        this.url("playlistItems", {
          part: "snippet,contentDetails,status",
          playlistId: uploadsPlaylistId,
          maxResults: opts.maxResults,
          pageToken: opts.pageToken,
        }),
        "data",
      );
      return {
        items: res.items ?? [],
        nextPageToken: res.nextPageToken,
        prevPageToken: res.prevPageToken,
        totalResults: res.pageInfo?.totalResults,
        playlistMissing: false,
      };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && e.reason === "playlistNotFound") {
        return { items: [], playlistMissing: true };
      }
      throw e;
    }
  }

  /** videos.list for up to 50 IDs per request (1 unit per request). */
  async getVideos(ids: string[]): Promise<VideoResource[]> {
    const out: VideoResource[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await this.client.getJson<ListResponse<VideoResource>>(
        this.url("videos", {
          part: "snippet,contentDetails,statistics,status,liveStreamingDetails",
          id: chunk.join(","),
          maxResults: 50,
        }),
        "data",
      );
      out.push(...(res.items ?? []));
    }
    return out;
  }
}
