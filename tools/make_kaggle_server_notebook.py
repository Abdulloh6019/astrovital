"""Build AstroMed_AI_Server_Kaggle.ipynb: the AI runs on a Kaggle T4, the UI stays on the laptop.

The notebook embeds the exact ai_engine.py / ai_remote.py from this repository, so the
Kaggle server and the laptop app always use the same prompt, labels and decision rules.
Run:  python tools/make_kaggle_server_notebook.py
"""
import base64
import json
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "kaggle" / "AstroMed_AI_Server_Kaggle.ipynb"


def b64(path):
    # zlib keeps the notebook small enough to paste/import comfortably
    return base64.b64encode(zlib.compress((ROOT / path).read_bytes(), 9)).decode()


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text}


cells = [
    md("# AstroAI server (Kaggle GPU) — DEMO\n\n"
       "Model shu notebookda T4 GPU'da ishlaydi, AstroVital oynasi esa laptopda ochiladi.\n\n"
       "1. **Settings → Accelerator: GPU T4**, **Internet: On**.\n"
       "2. **Add Input** → `notebook167853da03` chiqishi (V5.4 adapter, `AstroMed_V5_RESULTS.zip`).\n"
       "3. **Run All**. Oxirida chiqqan **AI SERVER MANZILI** ni AstroVital AstroAI panelidagi "
       "“Kaggle GPU ulanishi” maydoniga qo‘ying.\n\n"
       "Oxirgi katak ishlab turgan vaqtgacha server yoqiq. Tibbiy tasdiqlanmagan."),
    code("# 1. Kutubxonalar va Cloudflare tunnel (akkaunt yoki kalit kerak emas)\n"
         "!pip install -q transformers==4.57.1 peft==0.17.1 accelerate==1.10.1 sentencepiece fastapi uvicorn\n"
         "!wget -q -O /kaggle/working/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64\n"
         "!chmod +x /kaggle/working/cloudflared && /kaggle/working/cloudflared --version\n"
         "import torch; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'YO‘Q — Accelerator: GPU T4 ni yoqing')"),
    code("# 2. AstroAI kodi (repodagi ai_engine.py va ai_remote.py bilan aynan bir xil)\n"
         "import base64, os, sys, pathlib, zlib\n"
         "pkg = pathlib.Path('/kaggle/working/astro_medical'); pkg.mkdir(exist_ok=True)\n"
         "(pkg / '__init__.py').write_text('')\n"
         f"(pkg / 'ai_engine.py').write_bytes(zlib.decompress(base64.b64decode('{b64('astro_medical/ai_engine.py')}')))\n"
         f"(pkg / 'ai_remote.py').write_bytes(zlib.decompress(base64.b64decode('{b64('astro_medical/ai_remote.py')}')))\n"
         "os.environ['ASTRO_AI_DIR'] = '/kaggle/working/models'\n"
         "os.environ['ASTRO_AI_DEVICE'] = 'cuda'\n"
         "sys.path.insert(0, '/kaggle/working')\n"
         "print('Kod yozildi')"),
    code("# 3. V5.4 adapterini topish (Add Input orqali qo‘shilgan notebook chiqishidan)\n"
         "import glob, shutil, zipfile\n"
         "models = pathlib.Path('/kaggle/working/models'); models.mkdir(exist_ok=True)\n"
         "cfgs = glob.glob('/kaggle/input/**/adapter_config.json', recursive=True)\n"
         "if cfgs:\n"
         "    src = pathlib.Path(cfgs[0]).parent\n"
         "    shutil.copytree(src, models / 'adapter', dirs_exist_ok=True)\n"
         "    for c in glob.glob('/kaggle/input/**/inference_config.json', recursive=True)[:1]:\n"
         "        shutil.copy(c, models / 'inference_config.json')\n"
         "else:\n"
         "    zips = glob.glob('/kaggle/input/**/AstroMed_V5_RESULTS.zip', recursive=True)\n"
         "    assert zips, 'Adapter topilmadi: Add Input → notebook167853da03 (V5.4 chiqishi) ni qo‘shing'\n"
         "    with zipfile.ZipFile(zips[0]) as z:\n"
         "        for name in z.namelist():\n"
         "            if name.endswith('/'): continue\n"
         "            parts = pathlib.Path(name).parts\n"
         "            if 'adapter' in parts:\n"
         "                target = models / 'adapter' / pathlib.Path(*parts[parts.index('adapter') + 1:])\n"
         "            elif parts[-1] == 'inference_config.json':\n"
         "                target = models / 'inference_config.json'\n"
         "            else: continue\n"
         "            target.parent.mkdir(parents=True, exist_ok=True)\n"
         "            target.write_bytes(z.read(name))\n"
         "print(sorted(p.name for p in (models / 'adapter').iterdir()))\n"
         "assert (models / 'adapter' / 'adapter_config.json').is_file()"),
    code("# 4. Asosiy modellar (Kaggle internetida tez yuklanadi)\n"
         "from huggingface_hub import snapshot_download\n"
         "keep = ['*.json', '*.safetensors', '*.model', '*.txt', 'tokenizer*']\n"
         "snapshot_download('Qwen/Qwen2.5-3B-Instruct', local_dir=str(models / 'qwen2.5-3b-instruct'), allow_patterns=keep)\n"
         "snapshot_download('facebook/nllb-200-distilled-600M', local_dir=str(models / 'nllb-200-distilled-600M'), allow_patterns=keep + ['*.bin'])\n"
         "print('Modellar tayyor')"),
    code("# 5. Modelni GPU'ga yuklash va sinov\n"
         "import time\n"
         "from astro_medical.ai_engine import AIEngine, DEMO_RECORDS\n"
         "engine = AIEngine()\n"
         "print(engine.status())\n"
         "t = time.time(); engine.load(); print(f'Yuklandi: {time.time() - t:.0f} s')\n"
         "r = engine.analyze(DEMO_RECORDS)\n"
         "print('Harakat:', r['harakat'], '| vaqt:', r['sekund'], 's')\n"
         "for k, v in r['qaydlar'].items(): print(k, v['sinf'], v['ishonch'])"),
    code("# 6. Serverni ishga tushirish va internetga ochish — shu katak ishlab tursin\n"
         "import re, subprocess, threading, uvicorn\n"
         "from astro_medical.ai_remote import create_ai_server\n"
         "app = create_ai_server(engine)\n"
         "threading.Thread(target=lambda: uvicorn.run(app, host='127.0.0.1', port=8000, log_level='warning'), daemon=True).start()\n"
         "time.sleep(3)\n"
         "tunnel = subprocess.Popen(['/kaggle/working/cloudflared', 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8000'],\n"
         "                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n"
         "url = None\n"
         "for line in tunnel.stdout:\n"
         "    m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)\n"
         "    if m: url = m.group(0); break\n"
         "threading.Thread(target=lambda: [None for _ in tunnel.stdout], daemon=True).start()\n"
         "print('=' * 70)\n"
         "print('AI SERVER MANZILI:', url)\n"
         "print('Shu manzilni AstroVital AstroAI panelidagi “Kaggle GPU ulanishi” maydoniga qo‘ying.')\n"
         "print('=' * 70)\n"
         "while True:  # session ochiq turadi; to‘xtatish uchun Stop bosing\n"
         "    time.sleep(300)\n"
         "    print(time.strftime('%H:%M'), 'server ishlayapti', url, flush=True)"),
]

nb = {"cells": cells, "nbformat": 4, "nbformat_minor": 5,
      "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
                   "language_info": {"name": "python"},
                   "kaggle": {"accelerator": "nvidiaTeslaT4", "isInternetEnabled": True, "isGpuEnabled": True}}}
OUT.parent.mkdir(exist_ok=True)
OUT.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
print(OUT, OUT.stat().st_size, "bytes")
