import sherpa_onnx, soundfile as sf, json, sys, numpy as np
D="./sherpa-onnx-supertonic-3-tts-int8-2026-05-11/"
tts=sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
  supertonic=sherpa_onnx.OfflineTtsSupertonicModelConfig(duration_predictor=D+"duration_predictor.int8.onnx",text_encoder=D+"text_encoder.int8.onnx",
  vector_estimator=D+"vector_estimator.int8.onnx",vocoder=D+"vocoder.int8.onnx",tts_json=D+"tts.json",unicode_indexer=D+"unicode_indexer.bin",voice_style=D+"voice.bin"),num_threads=4)))
def say(text,sid,speed,out,steps=16):
    g=sherpa_onnx.GenerationConfig(); g.sid=sid; g.num_steps=steps; g.speed=speed; g.extra["lang"]="ko"
    a=tts.generate(text,g); sf.write(out,a.samples,a.sample_rate,subtype="PCM_16"); return len(a.samples)/a.sample_rate
if sys.argv[1]=="voices":
    for sid in range(5,10): print(sid, round(say("이제 클로드한테 말만 하면, 초안이 알아서 저장돼요.",sid,1.0,f"v{sid}.wav"),2))
else:
    sid=int(sys.argv[2]); sp=float(sys.argv[3])
    for i,(s,t) in enumerate(json.load(open("lines.json"))): print(i,s,round(say(t,sid,sp,f"m{i}.wav"),2),t)
