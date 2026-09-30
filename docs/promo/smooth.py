import soundfile as sf, numpy as np, json
SR=None
def env_db(x,sr):
    h=int(sr*.01); n=len(x)//h
    e=np.array([np.sqrt((x[i*h:(i+1)*h]**2).mean()) for i in range(n)]); return 20*np.log10(e+1e-9),h
def fade(n,kind):  # equal-power
    t=np.linspace(0,1,n); return np.sin(t*np.pi/2) if kind=="in" else np.cos(t*np.pi/2)
def process(path, maxgap=0.22, xf=0.04):
    global SR
    x,sr=sf.read(path); SR=sr
    db,h=env_db(x,sr); v=db>db.max()-40; idx=np.where(v)[0]
    a=max(0,idx[0]*h-int(.03*sr)); b=min(len(x),(idx[-1]+1)*h+int(.18*sr))
    # find inner silent runs
    segs=[]; run=0; st=None
    for i in range(idx[0],idx[-1]+1):
        if not v[i]:
            if run==0: st=i
            run+=1
        else:
            if run*0.01>maxgap: segs.append((st*h,(st+run)*h))
            run=0
    out=x[a:b].copy(); off=a
    for s,e in reversed(segs):
        s-=off; e-=off; keep=int(maxgap*sr); cut_s=s+keep//2; cut_e=e-keep//2
        n=int(xf*sr)
        left=out[:cut_s+n].copy(); right=out[cut_e:].copy()
        left[-n:]=left[-n:]*fade(n,"out")+right[:n]*fade(n,"in")
        out=np.concatenate([left,right[n:]])
    out[:int(.015*sr)]*=np.linspace(0,1,int(.015*sr))
    m=int(.12*sr); out[-m:]*=np.cos(np.linspace(0,np.pi/2,m))**2
    d,hh=env_db(out,sr); vv=np.repeat(d>d.max()-30,hh)[:len(out)]
    rms=np.sqrt((out[:len(vv)][vv]**2).mean()); out*=10**(-20/20)/rms   # voiced RMS -> -20 dBFS
    return out, (idx[0]*h-a)/sr
L=json.load(open("lines2.json")); takes="k6_0_1 k6_1_1 k6_2_1 k6_3_1 k6_4_1 k6_5_2".split()
onset=[0.45,4.6,11.6,18.0,24.7,30.3]      # 말이 시작되는 시점 = 장면 전환 직후
track=np.zeros(int(36*44100)); 
for i,t in enumerate(takes):
    y,lead=process(t+".wav")
    if i==0: track=np.zeros(int(36*SR))
    p=int((onset[i]-lead)*SR); track[p:p+len(y)]+=y
    print(t,f"{onset[i]:.2f}->{onset[i]+len(y)/SR-lead:.2f}s")
sf.write("narr_dry.wav",track,SR,subtype="FLOAT")
