import json, sys
from PIL import Image
import numpy as np
from scipy import ndimage
cfg=json.load(open("nw.json"))["geo"]; pal=json.load(open("palettes.json"))
PALE={(255,255,255),(254,254,254),(252,252,122),(255,248,193),(255,246,193),(255,245,194),(255,247,193),(254,247,192),(233,223,144)}
def extract(code):
    g=cfg[code]; arr=np.asarray(Image.open(f"all/{code}.gif").convert("RGB")).astype(int)
    x0,y0,x1,y1=[int(v) for v in g["panel"]]; sub=arr[y0:y1,x0:x1]
    key=sub[:,:,0]*65536+sub[:,:,1]*256+sub[:,:,2]
    colours=[tuple(c) for c in (pal["jpr"] if code=="jpr" else pal["master"])]
    allk=np.array([r*65536+gg*256+b for r,gg,b in colours]); pale=np.array([r*65536+gg*256+b for r,gg,b in colours if tuple(c for c in (r,gg,b)) in PALE or min(r,gg,b)>235])
    red=np.array([r*65536+gg*256+b for r,gg,b in colours if r>180 and gg<40])
    rain=np.isin(key,allk)
    strong=rain & ~np.isin(key,pale) & ~np.isin(key,red)
    near=ndimage.binary_dilation(strong,iterations=3)
    rain &= ~(np.isin(key,pale) & ~near) & ~(np.isin(key,red) & ~near)
    yy,xx=np.mgrid[y0:y1,x0:x1]
    rain &= np.hypot(xx-g["cx"],yy-g["cy"])<=g["range"]*g["s"]
    out=np.zeros((y1-y0,x1-x0,4),np.uint8); out[...,:3]=sub; out[...,3]=np.where(rain,255,0)
    return Image.fromarray(out), rain.mean()
codes=sys.argv[1].split(",")
tiles=[]
for c in codes:
    im,frac=extract(c); print(c,"rain fraction",round(float(frac),4))
    bg=Image.new("RGBA",im.size,(20,30,45,255)); bg.alpha_composite(im); bg.thumbnail((460,460)); tiles.append(bg)
W=460; out=Image.new("RGB",(W*3,W*((len(tiles)+2)//3)),"black")
for i,t in enumerate(tiles): out.paste(t,((i%3)*W,(i//3)*W))
out.save(sys.argv[2])
