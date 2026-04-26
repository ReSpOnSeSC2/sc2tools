import cv2
import numpy as np
import mss
import pytesseract
import time
import os
import shutil
import sys

# --- Tesseract Auto-Detection ---
# Checks multiple common install locations so the script works regardless of
# where Tesseract was installed (64-bit, 32-bit, user-local, or on PATH).
def find_tesseract():
    """Return the path to tesseract.exe, or None if not found."""
    # 1. Check if tesseract is on the system PATH (e.g. added by installer or manually)
    on_path = shutil.which("tesseract")
    if on_path:
        return on_path

    # 2. Check common Windows installation directories
    username = os.environ.get("USERNAME", "")
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        rf"C:\Users\{username}\AppData\Local\Tesseract-OCR\tesseract.exe",
        r"C:\tools\Tesseract-OCR\tesseract.exe",
        r"C:\ProgramData\chocolatey\bin\tesseract.exe",
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path

    return None

tesseract_path = find_tesseract()
if not tesseract_path:
    print("=" * 60)
    print("ERROR: Tesseract OCR engine not found!")
    print("")
    print("Please install Tesseract from:")
    print("  https://github.com/UB-Mannheim/tesseract/wiki")
    print("")
    print("During install, make sure to check:")
    print("  'Add Tesseract to system PATH'")
    print("")
    print("After installing, restart this script.")
    print("=" * 60)
    input("Press Enter to exit...")
    sys.exit(1)

pytesseract.pytesseract.tesseract_cmd = tesseract_path
print(f"Tesseract found at: {tesseract_path}")

# Your calibrated coordinates
# Zone 1 (Original)
Z1 = {"top": 466, "left": 470, "width": 46, "height": 15}
# Zone 2 (New)
Z2 = {"top": 468, "left": 1401, "width": 51, "height": 11}

print("SC2 Dual-Zone MMR Scanner running. Watching both sides...")

def scan_zone(sct, monitor):
    img = np.array(sct.grab(monitor))
    gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    gray = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, thresh = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY_INV)
    config = r'--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789'
    text = pytesseract.image_to_string(thresh, config=config).strip()
    return text if (text.isdigit() and 1000 <= int(text) <= 8000) else None

with mss.mss() as sct:
    while True:
        mmr_l = scan_zone(sct, Z1)
        mmr_r = scan_zone(sct, Z2)
        
        # If we found at least one valid 4-digit number
        if mmr_l or mmr_r:
            found = [m for m in [mmr_l, mmr_r] if m]
            print(f"Detected MMR(s) on screen: {', '.join(found)}")
            
            # Save all found numbers separated by commas
            with open("scanned_mmr.txt", "w") as f:
                f.write(",".join(found))
            
            time.sleep(20) # Cooldown for the rest of the loading screen
            
        time.sleep(0.5)