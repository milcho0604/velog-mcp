import sherpa_onnx, soundfile as sf, json, sys
d="vits-mimic3-ko_KO-kss_low/"
cfg=sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=d+"ko_KO-kss_low.onnx",tokens=d+"tokens.txt",data_dir=d+"espeak-ng-data",length_scale=float(sys.argv[1]) if len(sys.argv)>1 else 1.0),num_threads=4))
tts=sherpa_onnx.OfflineTts(cfg)
lines=json.load(open("lines.json"))
for i,(start,text) in enumerate(lines):
    a=tts.generate(text,sid=0,speed=1.0)
    sf.write(f"n{i}.wav",a.samples,a.sample_rate)
    print(i,start,round(len(a.samples)/a.sample_rate,2),text)
