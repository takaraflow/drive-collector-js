// __tests__/mocks/aws-s3.js
export const S3Client = function() {
  return {
    send: () => Promise.resolve({})
  };
};