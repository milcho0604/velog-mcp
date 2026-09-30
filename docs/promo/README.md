# 홍보 영상

`velog-mcp-ad.mp4` — 1920×1080 · 30fps · 36초 · 무음.
`velog-mcp-ad-narrated.mp4` — 같은 영상에 한국어 나레이션을 얹은 버전.

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

## 나레이션

대사와 시작 시점(초)은 `lines.json` 에 있다. 음성은 오프라인 TTS
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + `vits-mimic3-ko_KO-kss_low`(KSS 데이터셋)로 합성한다.
`low` 품질 모델이라 기계음이 섞인다 — 실제 게시용이면 사람 목소리나 상용 TTS 로 바꿔 넣는 걸 권한다.

```bash
pip install sherpa-onnx soundfile
curl -sSL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-mimic3-ko_KO-kss_low.tar.bz2 | tar xj
python3 narr.py                     # n0.wav … n5.wav
# 각 줄을 lines.json 의 시작 시점에 놓고 섞어 영상에 입힌다
ffmpeg -i n0.wav … -filter_complex "[0:a]adelay=400:all=1[a0];…;[a0]…amix=inputs=6:normalize=0,loudnorm=I=-16:TP=-1.5[out]" \
  -map "[out]" narration.wav
ffmpeg -i velog-mcp-ad.mp4 -i narration.wav -map 0:v -map 1:a -c:v copy -c:a aac -shortest velog-mcp-ad-narrated.mp4
```
