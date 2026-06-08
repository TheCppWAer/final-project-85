from flask import Flask

import config
from routes import bp

app = Flask(__name__)
app.secret_key = config.SECRET_KEY

# ── 作弊／開發測試開關 ──────────────────────────────────
# True 時 /api/question 會附帶正確答案座標，前端直接在地圖標出答案（方便測試）。
# 正式上線前務必改回 False，否則玩家可從網路請求直接看到答案。
app.config["DEV_SHOW_ANSWER"] = False

app.register_blueprint(bp)

if __name__ == "__main__":
    app.run(debug=True)
