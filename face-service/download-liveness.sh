#!/bin/bash
# Download MiniFASNet V2 ONNX model for liveness detection
# From: minivision-ai/Silent-Face-Anti-Spoofing

mkdir -p face-service/models

# The model needs to be exported from PyTorch to ONNX first
# This script provides instructions and a placeholder

echo "活體偵測模型需手動準備："
echo "1. Clone: git clone https://github.com/minivision-ai/Silent-Face-Anti-Spoofing.git"
echo "2. Convert pth to ONNX using project's conversion script"
echo "3. Copy minifasnet.onnx to face-service/models/"
echo "4. Run: docker compose build face && docker compose up -d face"
echo "5. Verify: docker compose exec app wget -qO- http://face:8000/health | grep liveness_loaded"
