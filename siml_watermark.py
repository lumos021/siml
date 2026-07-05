"""
siml-watermark : Tier-1 robust pixel watermark for SIML  (corrected build)

STATUS: HISTORICAL. This is the original validated recipe. The canonical,
current implementation is the JavaScript writer
(packages/siml-writer/src/watermark.js), which adds dual-band placement
(smooth blocks byte-untouched or embedded at half-strength Q=13), a
prime-padded bitstream, and positional vote guarantees, and is pinned by the
conformance suite (measured 46.7-49 dB PSNR). Images embedded by this file
still decode: the JS decoder's third attempt is legacy full-coverage
compatible. See SIML-SPEC-v0.3.md section 12.

Core = fixed-step low-mid QIM (survives JPEG/WebP down to ~q30). Upgrades kept
after testing (fancier schemes were tried and DISCARDED - see notes):
  - Soft-decision voting: distance-to-even/odd bin as a soft vote summed across
    redundant blocks -> lower BER than hard majority. (Pure win.)
  - Reed-Solomon ECC + CRC: RS corrects residual errors; the CRC REJECTS RS
    miscorrections so the decoder fails loudly instead of returning a wrong
    number. (The single most important production property.)
  - Canonical-resolution resync + row-tiled bit assignment (crop tolerance).

DISCARDED after measurement (kept here as a warning):
  - Spread-spectrum w/ high-freq coefficients: LESS JPEG-robust than low-mid QIM.
  - Adaptive per-block step (perceptual masking): destabilized scale resync  - 
    downscaling shifts the texture measure so embedder/decoder disagree, breaking
    the ds900 case the fixed-step version handles. Net negative. Do not re-add
    without a scale-invariant mask.

Measured (1024x512 ref, PSNR ~39 dB, 6-byte phone payload):
  survives: JPEG q30+, WebP, double-JPEG, screenshot, downscale->480 (alone),
            downscale->900 + recompress.
  fails (loudly, CRC-rejected): downscale <=800 + recompress  -> Tier 2's job.
"""
import numpy as np, io
from scipy.fftpack import dct, idct
from PIL import Image
import reedsolo

CANON_W = 1024
COEF = (2, 1)            # low-mid: robust under JPEG (matches the working spike)
Q = 26.0
RS_NSYM = 4              # parity bytes

def _dct2(b):  return dct(dct(b.T, norm='ortho').T, norm='ortho')
def _idct2(b): return idct(idct(b.T, norm='ortho').T, norm='ortho')
def _y_of(img): return np.asarray(img.convert("YCbCr"), np.float32)
def _img_of(y): return Image.fromarray(np.clip(y,0,255).astype(np.uint8),"YCbCr").convert("RGB")

def _canonical(img):
    w,h=img.size; cw=CANON_W; ch=int(round(cw*h/w/8)*8)
    return img.resize((cw,ch), Image.LANCZOS)

def _blocks(h,w): return [(by,bx) for by in range(0,h-7,8) for bx in range(0,w-7,8)]

def _embed_bit(D, bit):
    c=D[COEF]; q=np.round(c/Q)
    if (int(q)&1)!=bit:
        q = q+1 if (c/Q-q)>=0 else q-1
        if (int(q)&1)!=bit: q+=1
    D[COEF]=q*Q; return D

def _soft_bit(D):
    c=D[COEF]
    qe=2*np.round(c/(2*Q));            # nearest even multiple index
    qo=2*np.round((c-Q)/(2*Q))+1       # nearest odd multiple index
    de=abs(c-qe*Q); do=abs(c-qo*Q)
    return do-de                       # >0 => closer to even (bit0); soft magnitude

def _crc16(b):
    c=0xFFFF
    for x in b:
        c^=x<<8
        for _ in range(8): c=((c<<1)^0x1021)&0xFFFF if c&0x8000 else (c<<1)&0xFFFF
    return c
def _bits(bs): return np.unpackbits(np.frombuffer(bs,np.uint8))
def _bytes(a): return np.packbits(a).tobytes()

def embed(img, data: bytes):
    crc=_crc16(data); data=data+bytes([crc>>8, crc&0xFF])
    coded=bytes(reedsolo.RSCodec(RS_NSYM).encode(bytearray(data)))
    bits=_bits(coded); nb=len(bits)
    cimg=_canonical(img); ycc=_y_of(cimg).copy(); Y=ycc[...,0]; H,W=Y.shape
    assert nb<=W//8, f"{nb} bits > {W//8} cols; reduce payload for row-tiling"
    for (by,bx) in _blocks(H,W):
        bit=int(bits[(bx//8)%nb])
        Y[by:by+8,bx:bx+8]=_idct2(_embed_bit(_dct2(Y[by:by+8,bx:bx+8]), bit))
    ycc[...,0]=Y; return _img_of(ycc), nb

def extract(img, nb, ndata):
    cimg=_canonical(img); Y=_y_of(cimg)[...,0]; H,W=Y.shape
    soft=np.zeros(nb)
    for (by,bx) in _blocks(H,W):
        soft[(bx//8)%nb]+=_soft_bit(_dct2(Y[by:by+8,bx:bx+8]))
    bits=(soft<0).astype(np.uint8)
    try:
        dec=bytes(reedsolo.RSCodec(RS_NSYM).decode(bytearray(_bytes(bits)))[0])
        payload,crc=dec[:-2],(dec[-2]<<8)|dec[-1]
        if _crc16(payload)!=crc: return None, False   # reject RS miscorrection
        return payload, True
    except reedsolo.ReedSolomonError:
        return None, False

if __name__=="__main__":
    from PIL import ImageDraw, ImageFont
    def fnt(s,b=True):
        p="DejaVuSans-Bold.ttf" if b else "DejaVuSans.ttf"
        return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{p}",s)
    def banner():
        W,H=1024,512; img=Image.new("RGB",(W,H)); px=img.load()
        for y in range(H):
            for x in range(W): px[x,y]=(int(40+80*x/W),int(30+70*y/H),int(90+90*(x+y)/(W+H)))
        d=ImageDraw.Draw(img)
        d.text((60,110),"ACME DESIGN STUDIO",fill=(255,240,200),font=fnt(52))
        d.text((60,300),"Call: +91 98765 43210",fill=(255,230,180),font=fnt(48))
        return img
    def jpeg(im,q):
        b=io.BytesIO(); im.save(b,"JPEG",quality=q); b.seek(0); return Image.open(b).convert("RGB")
    def webp(im,q):
        b=io.BytesIO(); im.save(b,"WEBP",quality=q); b.seek(0); return Image.open(b).convert("RGB")
    def ds(im,w): return im.resize((w,int(round(im.height*w/im.width))),Image.LANCZOS)
    def psnr(a,b):
        a=np.asarray(a,float); b=np.asarray(b,float); m=np.mean((a-b)**2)
        return 99 if m==0 else 10*np.log10(255**2/m)
    def sshot(im):
        s=ds(im,int(im.width*0.85)); a=np.asarray(s,float)+np.random.default_rng(0).normal(0,2.5,(s.height,s.width,3))
        return jpeg(Image.fromarray(np.clip(a,0,255).astype(np.uint8)),70)

    phone="919876543210"
    data=bytes(int(phone[i:i+2]) for i in range(0,12,2))   # 6 data bytes
    src=banner(); wm,nb=embed(src,data); ndata=len(data)
    print(f"payload={ndata}B -> {nb} coded bits (RS+{RS_NSYM}); PSNR={psnr(src,wm):.1f} dB (spike 39.1)\n")
    atks={"no attack":wm,"JPEG q60":jpeg(wm,60),"JPEG q40":jpeg(wm,40),"JPEG q30":jpeg(wm,30),
          "WebP q60":webp(wm,60),"double JPEG60":jpeg(jpeg(wm,60),60),"screenshot":sshot(wm),
          "ds900+q60":jpeg(ds(wm,900),60),"ds800+q60":jpeg(ds(wm,800),60),
          "ds720+q60":jpeg(ds(wm,720),60),"ds640+q60":jpeg(ds(wm,640),60),"ds480 only":ds(wm,480)}
    print(f"{'attack':18s} {'decoded':>8s} {'phone':>14s}")
    print("-"*42)
    for n,a in atks.items():
        dec,ok=extract(a,nb,ndata)
        if ok: ph="".join(f"{x:02d}" for x in dec[:6]); print(f"{n:18s} {'YES':>8s} {ph:>14s} {'ok' if ph==phone else '??'}")
        else:  print(f"{n:18s} {'FAIL':>8s} {'--':>14s}")