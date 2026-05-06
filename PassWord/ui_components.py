from PyQt6.QtWidgets import *
from PyQt6.QtCore import *
from PyQt6.QtGui import *

class DarkStyle:
    MAIN_BG = "#1e1e1e"
    PANEL_BG = "#252525"
    ACCENT = "#3F51B5"
    TEXT_COLOR = "#e0e0e0"
    INPUT_BG = "#2a2a2a"
    
    SHEET = f"""
        QMainWindow, QDialog {{ background-color: {MAIN_BG}; color: {TEXT_COLOR}; }}
        QWidget {{ color: {TEXT_COLOR}; font-family: '.AppleSystemUIFont', 'Arial', sans-serif; }}
        QLineEdit {{ 
            background-color: {INPUT_BG}; 
            border: 1px solid #444; 
            border-radius: 5px; 
            padding: 8px; 
            color: white; 
        }}
        QPushButton {{ 
            background-color: {ACCENT}; 
            color: white; 
            border-radius: 5px; 
            padding: 8px 15px; 
            font-weight: bold; 
        }}
        QPushButton:hover {{ background-color: #5c6bc0; }}
        QTableWidget {{ 
            background-color: {PANEL_BG}; 
            border: none; 
            gridline-color: #333; 
            color: {TEXT_COLOR}; 
        }}
        QHeaderView::section {{ 
            background-color: #333; 
            color: #aaa; 
            border: none; 
            padding: 5px; 
        }}
    """