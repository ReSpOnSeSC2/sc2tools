import cv2
import os

# Load the screenshot you took of the SC2 loading screen
image_path = "loading_screen.png"

if not os.path.exists(image_path):
    print(f"Error: Could not find '{image_path}'. Make sure it's in the same folder as this script.")
    input("Press Enter to exit...")
    exit()

img = cv2.imread(image_path)

print("INSTRUCTIONS:")
print("1. A window will open showing your loading screen.")
print("2. Click and drag a tight box strictly around the OPPONENT'S MMR numbers.")
print("3. Press ENTER or SPACE to confirm the box.")

# Select ROI (Region of Interest)
roi = cv2.selectROI("Select Opponent MMR", img, fromCenter=False, showCrosshair=True)

x, y, w, h = roi

print("\n--- YOUR CALIBRATION COORDINATES ---")
print(f"X: {x}")
print(f"Y: {y}")
print(f"Width: {w}")
print(f"Height: {h}")
print("------------------------------------")

cv2.destroyAllWindows()

# This keeps the window open so you can actually read the numbers!
input("\nSuccess! Copy those numbers, then press Enter to close this window...")