#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
// Local operator entrypoint. The kernel releases the executor lock on process exit.
int main(int argc, char **argv) {
 if(argc==4 && strcmp(argv[1],"--verify-lock")==0) {
  char *end=NULL;long parsed=strtol(argv[3],&end,10);
  if(!end||*end||parsed<3||parsed>1024)return 73;
  int inherited=(int)parsed;struct stat held,expected;
  if(fstat(inherited,&held)||lstat(argv[2],&expected)||!S_ISREG(held.st_mode)||!S_ISREG(expected.st_mode)||held.st_uid!=getuid()||(held.st_mode&0077)||held.st_dev!=expected.st_dev||held.st_ino!=expected.st_ino||flock(inherited,LOCK_EX|LOCK_NB))return 73;
  return 0;
 }
 if(argc<4){fputs("usage: lock-run LOCK ABSOLUTE_EXECUTABLE [ARGS...]\n",stderr);return 64;}
 umask(0077);
 int fd=open(argv[1],O_RDWR|O_CREAT|O_NOFOLLOW,0600);
 struct stat st;
 if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=getuid()||flock(fd,LOCK_EX|LOCK_NB)) {fputs("executor_lock_unavailable\n",stderr);return 73;}
 if(argv[2][0]!='/'){fputs("absolute executable required\n",stderr);return 64;}
 char descriptor[32];snprintf(descriptor,sizeof(descriptor),"%d",fd);
 setenv("THINGS_EXECUTOR_LOCK_FD",descriptor,1);
 execv(argv[2],argv+2);perror("execv");return 71;
}
