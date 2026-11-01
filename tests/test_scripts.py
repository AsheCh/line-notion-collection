import collect
import setup_db


def test_extract_page_id_from_notion_link():
    link = "https://www.notion.so/My-Page-0123456789abcdef0123456789abcdef?pvs=4"
    assert setup_db.extract_page_id(link) == "01234567-89ab-cdef-0123-456789abcdef"


def test_extract_page_id_from_dashed_id():
    assert setup_db.extract_page_id("01234567-89ab-cdef-0123-456789abcdef").startswith("01234567-")


def test_categories_match_db_schema():
    # collect.py 的分類白名單必須與建庫時的選項完全一致，否則回寫會失敗
    schema_options = [o["name"] for o in setup_db.DB_SCHEMA["分類"]["select"]["options"]]
    assert collect.VALID_CATEGORIES == schema_options


def test_plain_text_join():
    assert collect._plain([{"plain_text": "收"}, {"plain_text": "藏"}]) == "收藏"


def test_extract_page_id_title_ending_with_hex_letter():
    # 標題結尾是 a-f 字母時（如 Page、Cafe），不能被誤併進 ID
    link = "https://www.notion.so/Cafe-fedcba9876543210fedcba9876543210"
    assert setup_db.extract_page_id(link) == "fedcba98-7654-3210-fedc-ba9876543210"
