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

목소리는 Supertonic 3 의 **M2**(중년 남성, 중앙 F0 약 97Hz)다. 대사는 `lines.json`, 말이 시작되는 시점은 `smooth.py` 의 `onset`.
오프라인 TTS [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + `sherpa-onnx-supertonic-3-tts-int8-2026-05-11`
(MIT, Supertone Inc.)로 합성한다. sid 5–9 가 M1–M5, 0–4 가 F1–F5.

생성이 확률적이라 같은 문장도 테이크마다 조금씩 다르다 — 몇 번 뽑아 발음이 가장 깨끗한 걸 고른다.

```bash
pip install sherpa-onnx soundfile
curl -sSL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2 | tar xj
python3 narr.py voices          # 같은 문장을 M1–M5 로 (v5.wav … v9.wav)
python3 narr.py lines 6 1.05    # sid 6(M2), 속도 1.05 로 전 대사 → m0.wav … m5.wav
# 다듬기: 앞뒤 무음 제거 · 문장 안 쉼을 220ms 로 줄이고 40ms 크로스페이드 ·
# 줄마다 음량을 맞춤 · 끝을 120ms 로 페이드. 결과는 narr_dry.wav (타임라인에 배치됨)
python3 smooth.py
# 이후 EQ·아주 짧은 잔향·2패스 loudnorm(-16 LUFS, TP -1.5)
ffmpeg -i m0.wav … -filter_complex "[0:a]adelay=400:all=1[a0];…;[a0]…amix=inputs=6:normalize=0,equalizer=f=3500:t=q:w=1:g=2,loudnorm=I=-16:TP=-1.5[out]" \
  -map "[out]" narration.wav
ffmpeg -i velog-mcp-ad.mp4 -i narration.wav -map 0:v -map 1:a -c:v copy -c:a aac -shortest velog-mcp-ad-narrated.mp4
```
