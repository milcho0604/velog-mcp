/** 벨로그 응답 타입. docs/api-reference.md 의 실측 스키마 기준. */

export interface VelogUserProfile {
	display_name?: string | null;
	short_bio?: string | null;
	thumbnail?: string | null;
}

export interface VelogUser {
	id?: string;
	username?: string;
	email?: string | null;
	profile?: VelogUserProfile | null;
}

export interface VelogSeries {
	id?: string;
	name?: string;
	url_slug?: string;
}

export interface VelogPostSummary {
	id: string;
	title: string;
	url_slug: string;
	short_description?: string | null;
	thumbnail?: string | null;
	likes?: number | null;
	views?: number | null;
	comments_count?: number | null;
	released_at?: string | null;
	// updated_at 은 질의하지 않는다 — 스키마는 non-nullable 인데 실제 null 인 글이
	// 있어 결과 전체가 거부된다. src/graphql.ts 주석 참고.
	is_private?: boolean | null;
	tags?: string[] | null;
	user?: VelogUser | null;
	series?: VelogSeries | null;
}

export interface VelogPostDetail extends VelogPostSummary {
	body?: string | null;
	is_markdown?: boolean | null;
	is_temp?: boolean | null;
	created_at?: string | null;
}

export interface SearchPostsResult {
	count: number;
	posts: VelogPostSummary[];
}
