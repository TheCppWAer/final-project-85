import requests

# 共用 HTTP Session（連線重用）；所有對外請求都用這個，避免各處各開連線
http_session = requests.Session()
