FROM syncfusion/dev-boldbi-docker:17.1.51_11062026_072923_193588_patch

# Keep the vendor's bundled PostgreSQL 15 and BoldBI entrypoint.
COPY cloudflare-entrypoint.sh /usr/local/bin/boldbi-eval-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/boldbi-eval-entrypoint && chmod 755 /usr/local/bin/boldbi-eval-entrypoint
WORKDIR /application
ENTRYPOINT ["/usr/local/bin/boldbi-eval-entrypoint"]
CMD ["/application/entrypoint.sh"]
EXPOSE 80
