def reverse(s):
    """反转字符串"""
    return s[::-1]


def capitalize_words(s):
    """将字符串中每个单词首字母大写"""
    return ' '.join(word.capitalize() for word in s.split())


def count_vowels(s):
    """统计字符串中元音字母的数量"""
    vowels = {'a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U'}
    count = 0
    for char in s:
        if char in vowels:
            count += 1
    return count
