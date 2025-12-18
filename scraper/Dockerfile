FROM python:3.11-slim
WORKDIR /app
COPY scraper/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY scraper/scrape_members.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "scrape_members.py"]

