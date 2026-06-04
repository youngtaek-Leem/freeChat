import calendar
import datetime

def main():
    now = datetime.datetime.now()
    print(f'Current Time: {now.strftime("%H:%M:%S")}')
    print('\nCalendar for {now.year}년 {now.month}월:')
    cal = calendar.TextCalendar(calendar.SUNDAY)
    print(cal.formatmonth(now.year, now.month))

if __name__ == '__main__':
    main()
