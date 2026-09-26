# 홍보 영상

`velog-mcp-ad.mp4` — 1920×1080 · 30fps · 36초 · 무음.

| 구간 | 장면 |
| --- | --- |
| 0–4s | 훅 — "벨로그 글, 아직도 손으로 쓰세요?" |
| 4–11s | `velog_create_draft` — 말 한마디로 비공개 초안 |
| 11–18s | `velog_blog_stats` — 조회수 상위 글 집계 |
| 18–24s | `velog_render_diagram` — 흐름도 + 자가감사 통과 후 업로드 |
| 24–30s | 발행은 권한 · 실측 · 의존성 2개 |
| 30–36s | 설치 명령 (`/plugin install velog@milcho`) |

통계 수치와 글 제목은 연출용 예시다.

## 다시 뽑기

`ad.html` 은 시간 `t` 를 받아 그 순간을 그리는 `render(t)` 하나로 돌아간다.
`rec.mjs` 가 프레임마다 `render(i/30)` 을 부르고 스크린샷을 ffmpeg 로 넘긴다 —
실시간 녹화가 아니라서 프레임이 빠지지 않는다.

```bash
cd docs/promo
# 폰트 (저장소에는 넣지 않음, OFL)
npm pack pretendard@1.3.9 @fontsource/jetbrains-mono
tar xzf pretendard-1.3.9.tgz && for w in Regular SemiBold Bold ExtraBold; do cp package/dist/web/static/woff2/Pretendard-$w.woff2 .; done && rm -rf package
tar xzf fontsource-jetbrains-mono-*.tgz && cp package/files/jetbrains-mono-latin-500-normal.woff2 JBMono.woff2 && rm -rf package *.tgz

node rec.mjs preview 2.8,9.5,16.5   # 특정 시점 PNG
FF=$(which ffmpeg) node rec.mjs video velog-mcp-ad.mp4   # 전체 (playwright 필요)
```
