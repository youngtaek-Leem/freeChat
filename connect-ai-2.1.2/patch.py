import sys

with open('src/extension.ts', 'r') as f:
    text = f.read()

# Replace the beginning of <script> and end of <script> with try-catch reporting
script_start = "<script>\n"
script_try_start = "<script>\ntry {\n"

script_end = "</script></body></html>"
script_try_end = """} catch(err) {
  document.body.innerHTML = '<div style="color:#ff4444;padding:20px;background:#111;height:100%;font-size:14px;overflow:auto;"><h2>\u26a0\ufe0f WEBVIEW JS CRASH</h2><pre>' + err.name + ': ' + err.message + '\\n' + err.stack + '</pre></div>';
}
</script></body></html>"""

text = text.replace(script_start, script_try_start)
text = text.replace(script_end, script_try_end)

# Also let's rename the view and extension id to completely bypass any cache or conflicts
text = text.replace("'local-ai-chat-view'", "'connect-ai-lab-v2-view'")

with open('src/extension.ts', 'w') as f:
    f.write(text)

print("Patch applied.")
